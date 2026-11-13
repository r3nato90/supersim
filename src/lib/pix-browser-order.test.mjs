import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { webcrypto } from "node:crypto";

function harness(fetch) {
  const source = readFileSync(
    new URL("../../public/inicio/js/checkout-shared.js", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("async function _pixRequestOrder(");
  const end = source.indexOf("// Purchase no navegador", start);
  const storage = new Map();
  const context = vm.createContext({
    crypto: webcrypto,
    TextEncoder,
    fetch,
    navigator: { locks: { request: (_key, run) => run() } },
    _pixClientData: () => ({ cpf: "11144477735", email: "cliente@example.com" }),
    localStorage: {
      getItem: (k) => storage.get(k) || null,
      setItem: (k, v) => storage.set(k, v),
      removeItem: (k) => storage.delete(k),
    },
  });
  vm.runInContext(source.slice(start, end), context);
  return { request: context._pixRequestOrder, storage };
}

test("reabrir modal/F5 com resposta salva não cria outro PIX", async () => {
  let calls = 0;
  const { request } = harness(async () => {
    calls++;
    return Response.json({ success: true, txnId: "c", qrcode: "000201", expiresAt: "2099-01-01T00:00:00Z" });
  });
  assert.equal((await request("produto", { clientOrderId: "order-123" })).txnId, "c");
  assert.equal((await request("produto", { clientOrderId: "order-456" })).txnId, "c");
  assert.equal(calls, 1);
});

test("timeout solicita somente recuperação, nunca outra criação", async () => {
  let calls = 0;
  const { request } = harness(async (_url, init) => {
    const input = JSON.parse(init.body);
    if (input.recoverOnly) return Response.json({ success: false, message: "não foi conciliada" }, { status: 409 });
    calls++;
    throw new Error("timeout");
  });
  await assert.rejects(request("produto", { clientOrderId: "order-123" }), /timeout/);
  await assert.rejects(request("produto", { clientOrderId: "order-456" }), /não foi conciliada/);
  assert.equal(calls, 1);
});

test("erro local explicitamente seguro permite corrigir e reenviar", async () => {
  let calls = 0;
  const { request } = harness(async () =>
    ++calls === 1
      ? Response.json({ success: false, safeToRetry: true, message: "dados inválidos" })
      : Response.json({ success: true, txnId: "c", qrcode: "000201", expiresAt: "2099-01-01T00:00:00Z" }),
  );
  await assert.rejects(request("produto", { clientOrderId: "order-123" }), /dados inválidos/);
  assert.equal((await request("produto", { clientOrderId: "order-456" })).txnId, "c");
  assert.equal(calls, 2);
});

test("erro de validação na recuperação não remove uma criação desconhecida", async () => {
  let creations = 0;
  const { request, storage } = harness(async (_url, init) => {
    if (!JSON.parse(init.body).recoverOnly) { creations++; throw new Error("timeout"); }
    return Response.json({ success: false, safeToRetry: true, message: "dados inválidos" });
  });
  await assert.rejects(request("produto", { clientOrderId: "order-1" }), /timeout/);
  await assert.rejects(request("produto", { clientOrderId: "order-2" }), /dados inválidos/);
  await assert.rejects(request("produto", { clientOrderId: "order-3" }), /dados inválidos/);
  assert.equal(storage.size, 1);
  assert.equal(creations, 1);
});
