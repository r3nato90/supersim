import test from "node:test";
import assert from "node:assert/strict";
import { sealPaymentContext, openPaymentContext, contextVenda } from "./payment-context.ts";

const secret = "test-context-secret-with-at-least-32-characters";
export const sample = {
  reference: "order-test-123",
  createdAt: "2026-10-20 12:00:00",
  customer: {
    name: "Cliente Teste",
    email: "cliente@example.com",
    phone: "11999999999",
    document: "11144477735",
  },
  product: { id: "produto", name: "Produto de teste", priceInCents: 1234 },
  tracking: { utm_source: "teste", utm_campaign: null },
};

test("contexto do webhook é autenticado e não expõe dados pessoais", async () => {
  const token = await sealPaymentContext(sample, secret);
  assert.ok(!token.includes(sample.customer.email));
  assert.ok(!token.includes(sample.customer.document));
  const context = await openPaymentContext(token, secret);
  assert.equal(context?.reference, sample.reference);
  assert.equal(context?.createdAt, sample.createdAt);
  assert.deepEqual(context?.tracking, sample.tracking);
  const venda = contextVenda(context, "charge-123", "2026-10-20 12:10:00");
  assert.equal(venda.orderId, "charge-123");
  assert.equal(venda.createdAt, sample.createdAt);
  assert.equal(venda.status, "paid");
});

test("contexto rejeita adulteração, segredo errado, expiração e excesso de tamanho", async (t) => {
  const token = await sealPaymentContext(sample, secret);
  const [iv, cipher] = token.split(".");
  const changed = cipher[0] === "A" ? "B" : "A";
  assert.equal(await openPaymentContext(`${iv}.${changed}${cipher.slice(1)}`, secret), null);
  assert.equal(await openPaymentContext(token, secret + "wrong"), null);
  assert.equal(await openPaymentContext("a".repeat(9000), secret), null);
  const now = Date.now();
  t.mock.method(Date, "now", () => now + 8 * 86400000);
  assert.equal(await openPaymentContext(token, secret), null);
});
