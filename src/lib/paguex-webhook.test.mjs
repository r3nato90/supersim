import test from "node:test";
import assert from "node:assert/strict";
import { handlePaguexPaid } from "./paguex-webhook.ts";
import { sealPaymentContext } from "./payment-context.ts";
import { resolvePrimaryEnv } from "./pay-gateway.ts";

const secret = "whsec_test_signature_secret_32_characters";
const gateway = resolvePrimaryEnv({
  PIX_GATEWAY: "paguex",
  PIX_GATEWAY_API_KEY: "test",
  PIX_GATEWAY_WEBHOOK_SECRET: secret,
});
const context = {
  reference: "order-test-123",
  createdAt: "2026-10-20 12:00:00",
  customer: {
    name: "Cliente",
    email: "cliente@example.com",
    phone: "11999999999",
    document: "11144477735",
  },
  product: { id: "produto", name: "Produto", priceInCents: 1234 },
  tracking: { utm_source: "teste" },
};

function setup(t) {
  t.mock.property(process, "env", {
    ...process.env,
    UTMIFY_API_TOKEN: "utm-test",
    META_CAPI_TOKEN: "",
    PIX_PAYMENT_CONTEXT_SECRET: "",
  });
}

test("webhook envia UTMify paga sem navegador e preserva criação, valor e UTMs", async (t) => {
  setup(t);
  const token = await sealPaymentContext(context, secret);
  const orders = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    if (url.includes("pague-x"))
      return Response.json({
        id: "charge-123",
        status: "paid",
        amount: 1234,
        reference: context.reference,
      });
    orders.push(JSON.parse(init.body));
    return Response.json({ ok: true });
  });
  assert.equal((await handlePaguexPaid("charge-123", token, gateway)).status, 200);
  assert.equal(orders[0].orderId, "charge-123");
  assert.equal(orders[0].status, "paid");
  assert.equal(orders[0].createdAt, context.createdAt);
  assert.equal(orders[0].customer.email, context.customer.email);
  assert.equal(orders[0].trackingParameters.utm_source, "teste");
  assert.equal(orders[0].products[0].priceInCents, 1234);
});

test("falhas da UTMify pedem reentrega; repetição atualiza o mesmo pedido", async (t) => {
  setup(t);
  t.mock.method(console, "error", () => {});
  const token = await sealPaymentContext(context, secret);
  let attempts = 0;
  const ids = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    if (url.includes("pague-x"))
      return Response.json({
        id: "charge-123",
        status: "paid",
        amount: 1234,
        reference: context.reference,
      });
    ids.push(JSON.parse(init.body).orderId);
    return Response.json({}, { status: ++attempts === 1 ? 503 : 200 });
  });
  assert.equal((await handlePaguexPaid("charge-123", token, gateway)).status, 503);
  assert.equal((await handlePaguexPaid("charge-123", token, gateway)).status, 200);
  assert.deepEqual(ids, ["charge-123", "charge-123"]);
});

test("webhook não usa contexto de outro pedido nem valores adulterados", async (t) => {
  setup(t);
  const token = await sealPaymentContext(context, secret);
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return Response.json({ id: "charge-123", status: "paid", amount: 9999, reference: "outro" });
  });
  assert.equal((await handlePaguexPaid("charge-123", token, gateway)).status, 422);
  assert.equal(calls, 1);
});

test("API indisponível/pendente retorna 503, revisão não envia venda paga", async (t) => {
  setup(t);
  for (const [status, http] of [
    ["pending", 503],
    ["under_review", 200],
  ]) {
    const mocked = t.mock.method(globalThis, "fetch", async () =>
      Response.json({ id: "charge-123", status, amount: 1234 }),
    );
    assert.equal((await handlePaguexPaid("charge-123", null, gateway)).status, http);
    assert.equal(mocked.mock.calls.length, 1);
    mocked.mock.restore();
  }
});
