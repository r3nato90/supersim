import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { webcrypto } from "node:crypto";
import { Worker } from "node:worker_threads";

const source = readFileSync(
  new URL("../../public/inicio/js/checkout-shared.js", import.meta.url),
  "utf8",
);
function section(from, to) {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start);
  assert.ok(start >= 0 && end > start);
  return source.slice(start, end);
}
const requestSource = section("async function _pixRequestOrder(", "// Purchase no navegador");
const modalSource = section("function _pixOpenModal(", "function pixCopyCode(");
const timerSource = section("function _pixStartTimer(", "/* botão");

// Funções reais de modal/cache/timer/polling; DOM, relógio, storage e HTTP
// simulados. Não carrega pixels, imagens, scripts remotos ou dados de clientes.
function harness({ storage = new Map(), storageApi, create, expiresAt } = {}) {
  const elements = new Map();
  const intervals = new Map();
  const calls = [];
  const alerts = [];
  const requests = [];
  const customer = {
    nome: "Cliente de teste",
    cpf: "11144477735",
    email: "teste@example.com",
    phone: "11999999999",
  };
  let id = 0;
  let paid = false;
  let gatewayStatus = "pending";
  let now = Date.now();
  let serverReply;
  expiresAt ??= new Date(now + 1800000).toISOString();
  let purchases = 0;
  let queue = Promise.resolve();
  class Clock extends Date {
    static now() {
      return now;
    }
  }
  const context = vm.createContext({
    crypto: webcrypto,
    TextEncoder,
    Date: Clock,
    navigator: {
      locks: {
        request: (_key, run) => {
          const result = queue.then(run);
          queue = result.catch(() => {});
          return result;
        },
      },
    },
    window: { location: { protocol: "https:" } },
    document: {
      getElementById: (key) => {
        if (!elements.has(key)) elements.set(key, { style: {}, textContent: "", value: "" });
        return elements.get(key);
      },
    },
    localStorage: storageApi ?? {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
      removeItem: (key) => storage.delete(key),
      key: (index) => [...storage.keys()][index] ?? null,
      get length() {
        return storage.size;
      },
    },
    alert: (message) => alerts.push(message),
    setInterval: (run, ms) => {
      intervals.set(++id, { run, ms });
      return id;
    },
    clearInterval: (key) => intervals.delete(key),
    setTimeout: () => ++id, // Não navega nem executa callbacks de retenção.
    _pixClientData: () => customer,
    _waitFbq: () => {},
    _capiMirror: () => {},
    _getFbCookies: () => ({}),
    _persistEid: () => "test-eid",
    _srcUrl: () => "https://loja.test/inicio/9.html",
    getUtms: () => ({}),
    genEventId: (prefix) => `${prefix}-test-${++id}`,
    PIX_PRODUCTS: { seguro: { price: 28.63, name: "Produto teste" } },
    PIX_MESSAGES: {},
    _pixOpening: false,
    _pixPurchaseFired: false,
    _pixCurrentTxn: null,
    _pixCurrentUpKey: "",
    _pixCurrentGateway: "",
    _pixCurrentCreatedAt: "",
    _pixCurrentAmount: 0,
    _pixPollInterval: null,
    _pixTimerInterval: null,
    _pixTimerSecs: 900,
    _pixFirePurchase: () => {
      if (!context._pixPurchaseFired) {
        purchases++;
        context._pixPurchaseFired = true;
      }
    },
    fetch: async (url, init) => {
      const recovery = init?.body ? JSON.parse(init.body).recoverOnly === true : false;
      calls.push({ url, method: init?.method ?? "GET", recovery });
      if (url.startsWith("/api/public/sup-status?")) {
        return Response.json({ success: true, paid, status: paid ? "paid" : gatewayStatus });
      }
      assert.equal(url, "/api/public/sup-pix");
      assert.equal(init.method, "POST");
      if (recovery)
        return Response.json(
          serverReply || { success: false, message: "A criação anterior não foi conciliada." },
          { status: serverReply ? 201 : 409 },
        );
      if (create) return create();
      const count = calls.filter((call) => call.method === "POST" && !call.recovery).length;
      serverReply = {
        success: true,
        txnId: count === 1 ? "pending-mock" : `pending-mock-${count}`,
        status: "pending",
        gateway: "velani",
        amount: 28.63,
        qrcode: "000201-mock",
        expiresAt,
      };
      return Response.json(serverReply);
    },
  });
  vm.runInContext(requestSource + "\n" + modalSource + "\n" + timerSource, context);
  const request = context._pixRequestOrder;
  context._pixRequestOrder = (...args) => {
    const promise = request(...args);
    requests.push(promise);
    return promise;
  };
  async function drain() {
    await Promise.allSettled(requests);
    await new Promise(setImmediate);
  }
  return {
    context,
    storage,
    customer,
    calls,
    alerts,
    elements,
    intervals,
    drain,
    posts: () => calls.filter((call) => call.method === "POST" && !call.recovery).length,
    purchases: () => purchases,
    setPaid: () => {
      paid = true;
    },
    setStatus: (value) => {
      gatewayStatus = value;
    },
    setExpiry: (value) => {
      expiresAt = value;
    },
    open: () => context._pixOpenModal("seguro"),
    close: () => context._pixCloseModal(),
    tick: (ms, count = 1) => {
      for (let i = 0; i < count; i++) {
        now += ms;
        for (const [key, timer] of [...intervals]) {
          if (timer.ms === ms && intervals.has(key)) timer.run();
        }
      }
    },
  };
}

test("modal: 100 cliques simultâneos criam apenas um PIX pendente", async () => {
  const h = harness();
  for (let i = 0; i < 100; i++) h.open();
  await h.drain();
  assert.equal(h.posts(), 1);
  assert.equal(h.context._pixCurrentTxn, "pending-mock");
  assert.equal(h.context._pixOpening, false);
});

test("modal: fechar e reabrir 20 vezes conserva o PIX pendente", async () => {
  const h = harness();
  for (let i = 0; i < 20; i++) {
    h.open();
    await h.drain();
    h.close();
  }
  assert.equal(h.posts(), 1);
  assert.equal(h.alerts.length, 0);
  assert.equal(h.intervals.size, 0);
});

test("modal: consultar pendência repetidamente não cria cobranças nem confirma pagamento", async () => {
  const h = harness();
  h.open();
  await h.drain();
  for (let i = 0; i < 20; i++) {
    h.tick(5000);
    await h.drain();
  }
  assert.equal(h.posts(), 1);
  assert.equal(h.calls.filter((call) => call.method === "GET").length, 20);
  assert.equal(h.purchases(), 0);
});

test("modal: confirmação paga para polling e não cria outro PIX", async () => {
  const h = harness();
  h.open();
  await h.drain();
  h.setPaid();
  h.tick(5000);
  await h.drain();
  assert.equal(h.posts(), 1);
  assert.equal(h.purchases(), 1);
  assert.equal(h.intervals.size, 0);
  assert.equal(h.elements.get("pix-paid").style.display, "block");
});

test("modal: QR expirado não é exibido nem ganha outro timer", async () => {
  const h = harness({ expiresAt: "2000-01-01T00:00:00Z" });
  h.open();
  await h.drain();
  h.close();
  h.open();
  await h.drain();
  assert.equal(h.posts(), 1);
  assert.equal(h.intervals.size, 0);
  assert.equal(h.elements.get("pix-code"), undefined);
  assert.equal(h.calls.filter((call) => call.method === "GET").length, 1);
  assert.match(h.alerts.at(-1), /não está confirmado como expirado/);
  const saved = JSON.parse([...h.storage.values()][0]);
  assert.equal(saved.response.expiresAt, "2000-01-01T00:00:00Z");
});

test("modal: timer usa expiresAt e só encerra polling na validade real", async () => {
  const h = harness();
  h.open();
  await h.drain();
  h.tick(1000, 900);
  assert.equal(h.context._pixTimerSecs, 900);
  assert.equal(h.intervals.size, 2);
  h.tick(1000, 900);
  assert.equal(h.intervals.size, 0);
  assert.equal(h.elements.get("pix-timer").textContent, "❌ Expirado");
  assert.equal(h.posts(), 1);
});

test("modal: timeout recupera somente a resposta, sem recriar em resultado desconhecido", async () => {
  const h = harness({
    create: async () => {
      throw new Error("timeout simulado");
    },
  });
  h.open();
  await h.drain();
  h.open();
  await h.drain();
  assert.equal(h.posts(), 1);
  assert.equal(h.calls.filter((call) => call.method === "GET").length, 0);
  assert.equal(JSON.parse([...h.storage.values()][0]).state, "pending");
  assert.match(h.alerts.at(-1), /não foi conciliada/);
  assert.equal(h.context._pixOpening, false);
});

test("modal: storage indisponível bloqueia antes de criar cobrança", async () => {
  const fail = () => {
    throw new Error("storage indisponível");
  };
  const h = harness({ storageApi: { getItem: fail, setItem: fail, removeItem: fail } });
  h.open();
  await h.drain();
  assert.equal(h.posts(), 0);
  assert.match(h.alerts.at(-1), /storage indisponível/);
});

test("modal: cache corrompido não gera outro PIX, mas impede continuar", async () => {
  const h = harness();
  h.open();
  await h.drain();
  const key = [...h.storage.keys()][0];
  h.storage.set(key, "{json-incompleto");
  h.close();
  h.open();
  await h.drain();
  assert.equal(h.posts(), 1);
  assert.equal(h.alerts.length, 1);
  assert.equal(h.elements.get("pix-modal").style.display, "none");
});

test("modal: resposta perdida por quota é recuperada sem criar outro pendente", async () => {
  const storage = new Map();
  let failReady = true;
  const h = harness({
    storage,
    storageApi: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => {
        if (JSON.parse(value).state === "ready" && failReady) throw new Error("quota excedida");
        storage.set(key, value);
      },
      removeItem: (key) => storage.delete(key),
    },
  });
  h.open();
  await h.drain();
  assert.equal(JSON.parse([...storage.values()][0]).state, "pending");
  failReady = false;
  h.open();
  await h.drain();
  assert.equal(h.posts(), 1);
  assert.equal(JSON.parse([...storage.values()][0]).state, "ready");
  assert.match(h.alerts[0], /quota excedida/);
  assert.equal(h.alerts.length, 1);
  assert.equal(h.context._pixCurrentTxn, "pending-mock");
});

test("modal: espaços no e-mail não geram outro POST para o mesmo CPF", async () => {
  const h = harness();
  h.open();
  await h.drain();
  h.close();
  h.customer.email = " teste@example.com ";
  h.open();
  await h.drain();
  assert.equal(h.posts(), 1);
});

test("cache: caixa do e-mail e máscara do CPF preservam a identidade local", async () => {
  const h = harness();
  h.open();
  await h.drain();
  h.close();
  h.customer.email = "TESTE@example.com";
  h.customer.cpf = "111.444.777-35";
  h.open();
  await h.drain();
  assert.equal(h.posts(), 1);
});

test(
  "cache: modelo concorrente sem Web Locks bloqueia novas cobranças",
  { timeout: 15_000 },
  async (t) => {
    // Threads distintas, sem suporte a Web Locks. É um modelo do storage
    // compartilhado, NÃO um teste de abas reais.
    const shared = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2);
    const code = `
    const { parentPort, workerData } = require("node:worker_threads");
    const vm = require("node:vm");
    const { webcrypto } = require("node:crypto");
    const state = new Int32Array(workerData.shared);
    let posts = 0;
    const context = vm.createContext({
      crypto: webcrypto, TextEncoder, navigator: {},
      _pixClientData: () => ({ cpf: "11144477735", email: "teste@example.com" }),
      localStorage: {
        getItem() {
          const existed = Atomics.load(state, 0);
          return existed ? JSON.stringify({ orderId: "pending", state: "pending" }) : null;
        },
        setItem() { Atomics.store(state, 0, 1); },
        removeItem() { throw new Error("não deve apagar storage"); }
      },
      fetch: async () => {
        posts++;
        return Response.json({ success: true, txnId: "mock-" + workerData.index, qrcode: "000201" });
      }
    });
    vm.runInContext(workerData.source, context);
    context._pixRequestOrder("seguro", { clientOrderId: "order-thread-" + workerData.index })
      .then(() => { throw new Error("criação não deveria ser permitida"); })
      .catch(error => {
        if (!error.message.includes("navegador atualizado")) throw error;
        parentPort.postMessage({ posts });
      });
  `;
    const workers = Array.from(
      { length: 3 },
      (_, index) =>
        new Worker(code, {
          eval: true,
          workerData: { shared, index, source: requestSource },
        }),
    );
    t.after(async () => {
      await Promise.all(workers.map((worker) => worker.terminate()));
    });
    const results = await Promise.all(
      workers.map(
        (worker) =>
          new Promise((resolve, reject) => {
            worker.once("message", resolve);
            worker.once("error", reject);
            worker.once("exit", (code) => {
              if (code !== 0) reject(new Error(`worker saiu com ${code}`));
            });
          }),
      ),
    );
    assert.equal(
      results.reduce((total, result) => total + result.posts, 0),
      0,
    );
  },
);

test("modal: renovação só começa depois de consultar expiração confirmada", async () => {
  const h = harness({ expiresAt: "2000-01-01T00:00:00Z" });
  h.open();
  await h.drain();
  h.setStatus("expired");
  h.setExpiry("2099-01-01T00:00:00Z");
  h.open();
  await h.drain();
  assert.equal(h.posts(), 2);
  assert.equal(h.calls[1].method, "GET");
  assert.equal(h.context._pixCurrentTxn, "pending-mock-2");
});

test("modal: Pix antigo confirmado pago é exibido como pago sem renovar", async () => {
  const h = harness({ expiresAt: "2000-01-01T00:00:00Z" });
  h.open();
  await h.drain();
  h.setPaid();
  h.open();
  await h.drain();
  assert.equal(h.posts(), 1);
  assert.equal(h.purchases(), 1);
  assert.equal(h.elements.get("pix-paid").style.display, "block");
});

async function legacyKey(email = "teste@example.com") {
  const digest = await webcrypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode("11144477735|" + email),
  );
  return (
    "pix-order-v2:seguro:" +
    [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("")
  );
}

test("cache: migra QR da versão antiga sem criar outra cobrança", async () => {
  const old = {
    orderId: "legacy-order",
    state: "ready",
    response: {
      success: true,
      txnId: "legacy-txn",
      qrcode: "000201-old",
      expiresAt: "2099-01-01T00:00:00Z",
      amount: 28.63,
      gateway: "velani",
    },
  };
  const storage = new Map([[await legacyKey(), JSON.stringify(old)]]);
  const h = harness({ storage });
  h.open();
  await h.drain();
  assert.equal(h.posts(), 0);
  assert.equal(h.context._pixCurrentTxn, "legacy-txn");
  assert.ok([...storage.keys()].some((key) => key.startsWith("pix-order-v3:")));
  assert.ok(storage.has(await legacyKey())); // A aba antiga continua bloqueada.
});

test("cache: pendência antiga é migrada somente para recuperação, nunca para criação", async () => {
  const storage = new Map([
    [await legacyKey(), JSON.stringify({ orderId: "legacy-pending", state: "pending" })],
  ]);
  const h = harness({ storage });
  h.open();
  await h.drain();
  assert.equal(h.posts(), 0);
  assert.equal(h.calls[0].recovery, true);
  assert.match(h.alerts.at(-1), /não foi conciliada/);
});

test("cache: legado não identificável após troca de e-mail bloqueia criação por segurança", async () => {
  const storage = new Map([
    [
      await legacyKey("old@example.com"),
      JSON.stringify({ orderId: "legacy-pending", state: "pending" }),
    ],
  ]);
  const h = harness({ storage });
  h.open();
  await h.drain();
  assert.equal(h.calls.length, 0);
  assert.match(h.alerts.at(-1), /versão anterior/);
});

test("modal: gateway sem expiresAt não recebe prazo fictício e continua polling", async () => {
  const h = harness();
  h.setExpiry(null);
  h.open();
  await h.drain();
  assert.equal(h.posts(), 1);
  assert.equal(h.intervals.size, 1);
  assert.equal(h.elements.get("pix-timer").textContent, "⏳ Aguardando confirmação");
});
