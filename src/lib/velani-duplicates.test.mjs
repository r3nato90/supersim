import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { webcrypto } from "node:crypto";
import { primaryCreate, resolvePrimaryEnv } from "./pay-gateway.ts";
import { createPixCreationGuard, pixOrderReference } from "./pix-order.ts";

const source = readFileSync(
  new URL("../../public/inicio/js/checkout-shared.js", import.meta.url),
  "utf8",
);
const start = source.indexOf("async function _pixRequestOrder(");
const end = source.indexOf("// Purchase no navegador", start);
assert.ok(start >= 0 && end > start);

// Usa a função real do navegador e o adapter real, mas NÃO executa a rota
// sup-pix nem acessa serviços externos. O transporte para a Velani é simulado;
// os resultados medem POSTs/chaves, não a idempotência do provedor real.
function harness(t, { gatewayStatus = 200, timeout = false } = {}) {
  const env = resolvePrimaryEnv({
    PIX_GATEWAY: "velani",
    PIX_GATEWAY_API_KEY: "sk_live_mock_only",
  });
  const calls = [];
  const guardedCreate = createPixCreationGuard();
  t.mock.method(console, "error", () => {});
  t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.equal(url, env.createUrl);
    assert.equal(init.method, "POST");
    calls.push({
      key: init.headers["x-idempotency-key"],
      body: JSON.parse(init.body),
    });
    if (timeout) throw new Error("timeout simulado");
    return Response.json(
      gatewayStatus >= 400
        ? { success: false, message: "indisponível" }
        : {
            success: true,
            data: {
              id: `mock-${calls.length}`,
              pixQrCode: "000201-mock",
              expiresAt: "2099-01-01T00:00:00Z",
            },
          },
      { status: gatewayStatus },
    );
  });

  function browser({ storage = new Map(), locks = mockLocks(), customer } = {}) {
    customer ??= { cpf: "11144477735", email: "teste@example.com" };
    const context = vm.createContext({
      crypto: webcrypto,
      TextEncoder,
      navigator: locks ? { locks } : {},
      _pixClientData: () => customer,
      localStorage: {
        getItem: (key) => storage.get(key) ?? null,
        setItem: (key, value) => storage.set(key, value),
        removeItem: (key) => storage.delete(key),
      },
      fetch: async (url, init) => {
        assert.equal(url, "/api/public/sup-pix");
        const input = JSON.parse(init.body);
        const reference = await pixOrderReference(input.cpf, "front", 2863, env);
        return guardedCreate(
          reference,
          async () => {
            const result = await primaryCreate(
              {
                amount: 2863,
                customer: {
                  name: "Cliente de teste",
                  email: input.email,
                  document: { type: "cpf", number: input.cpf },
                },
                items: [{ title: "Produto de teste", unit_price: 2863, quantity: 1 }],
                metadata: { order_id: reference },
              },
              env,
            );
            if (result.httpStatus >= 400) {
              return Response.json({ success: false, message: "indisponível" });
            }
            return Response.json({
              success: true,
              txnId: result.data.data.id,
              qrcode: result.data.data.pixQrCode,
              expiresAt: result.data.data.expiresAt,
            });
          },
          input.recoverOnly === true,
        );
      },
    });
    vm.runInContext(source.slice(start, end), context);
    return {
      storage,
      customer,
      request: (reference, upKey = "seguro") =>
        context._pixRequestOrder(upKey, {
          upKey,
          cpf: customer.cpf,
          email: customer.email,
          clientOrderId: reference,
        }),
    };
  }
  return { browser, calls };
}

// Modelo de exclusão mútua para testar o branch Web Locks, não um browser real.
function mockLocks() {
  const pending = new Map();
  return {
    request(key, run) {
      const next = (pending.get(key) ?? Promise.resolve()).then(run);
      pending.set(
        key,
        next.catch(() => {}),
      );
      return next;
    },
  };
}

test("Velani: três reaberturas preservam o PIX e enviam um POST", async (t) => {
  const { browser, calls } = harness(t);
  const page = browser();
  for (let i = 0; i < 3; i++) {
    assert.equal((await page.request(`order-${i}`)).txnId, "mock-1");
  }
  assert.equal(calls.length, 1);
});

test("Velani: recarga com armazenamento preservado envia um POST", async (t) => {
  const { browser, calls } = harness(t);
  const storage = new Map();
  await browser({ storage }).request("order-before-reload");
  const result = await browser({ storage }).request("order-after-reload");
  assert.equal(result.txnId, "mock-1");
  assert.equal(calls.length, 1);
});

test("Velani: três abas simultâneas com locks e storage compartilhados enviam um POST", async (t) => {
  const { browser, calls } = harness(t);
  const options = { storage: new Map(), locks: mockLocks() };
  const results = await Promise.all(
    Array.from({ length: 3 }, (_, i) => browser(options).request(`order-tab-${i}`)),
  );
  assert.equal(calls.length, 1);
  assert.ok(results.every((result) => result.txnId === "mock-1"));
});

test("Velani: três chamadas na mesma página enviam um POST", async (t) => {
  const { browser, calls } = harness(t);
  const page = browser();
  const results = await Promise.allSettled(
    Array.from({ length: 3 }, (_, i) => page.request(`order-click-${i}`)),
  );
  assert.ok(results.some((result) => result.status === "fulfilled"));
  assert.equal(calls.length, 1);
});

test("Velani: timeout conserva bloqueio e não repete POST desconhecido", async (t) => {
  const { browser, calls } = harness(t, { timeout: true });
  const page = browser();
  await assert.rejects(page.request("order-timeout"), /Não foi possível confirmar/);
  await assert.rejects(page.request("order-retry"), /Não foi possível confirmar/);
  assert.equal(calls.length, 1);
});

test("Velani: HTTP 503 conserva bloqueio e não repete criação", async (t) => {
  const { browser, calls } = harness(t, { gatewayStatus: 503 });
  const page = browser();
  await assert.rejects(page.request("order-503"), /indisponível/);
  await assert.rejects(page.request("order-retry"), /indisponível/);
  assert.equal(calls.length, 1);
});

test("Velani: mesmo CPF com outro e-mail reutiliza o primeiro PIX", async (t) => {
  const { browser, calls } = harness(t);
  const page = browser();
  await page.request("order-email-1");
  page.customer.email = "outro@example.com";
  await page.request("order-email-2");
  assert.equal(calls.length, 1);
});

test("Velani: limpar armazenamento não duplica na mesma instância do servidor", async (t) => {
  const { browser, calls } = harness(t);
  const storage = new Map();
  for (let i = 0; i < 3; i++) {
    storage.clear();
    await browser({ storage }).request(`order-cleared-${i}`);
  }
  assert.equal(calls.length, 1);
  assert.equal(new Set(calls.map((call) => call.key)).size, 1);
});

test("Velani: navegadores isolados reutilizam a compra na mesma instância", async (t) => {
  const { browser, calls } = harness(t);
  await Promise.all(Array.from({ length: 3 }, (_, i) => browser().request(`order-device-${i}`)));
  assert.equal(calls.length, 1);
  assert.equal(new Set(calls.map((call) => call.key)).size, 1);
});

test("Velani: três tentativas, última com e-mail alterado, produzem um único POST", async (t) => {
  const { browser, calls } = harness(t);
  const page = browser();
  await page.request("order-attempt-1");
  await page.request("order-attempt-2");
  page.customer.email = "outro@example.com";
  await page.request("order-attempt-3");
  assert.equal(calls.length, 1);
});

test("Velani: sem Web Locks uma nova criação é bloqueada antes do POST", async (t) => {
  const { browser, calls } = harness(t);
  await assert.rejects(browser({ locks: null }).request("order-unsafe"), /navegador atualizado/);
  assert.equal(calls.length, 0);
});

test("Velani: sem Web Locks ainda é permitido reaproveitar QR já salvo", async (t) => {
  const { browser, calls } = harness(t);
  const storage = new Map();
  await browser({ storage }).request("order-original");
  assert.equal((await browser({ storage, locks: null }).request("order-reopen")).txnId, "mock-1");
  assert.equal(calls.length, 1);
});
