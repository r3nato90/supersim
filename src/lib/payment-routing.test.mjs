import test from "node:test";
import assert from "node:assert/strict";
import { gatewayForKind, lookupPayment } from "./payment-routing.ts";

const env = {
  PIX_GATEWAY: "paguex",
  PIX_GATEWAY_API_KEY: "new-key",
  PIX_GATEWAY_CREATE_URL: "https://api.pague-x.com.br/v1/charges",
  PIX_GATEWAY_BEEHIVE_API_KEY: "old-key",
  PIX_GATEWAY_BEEHIVE_WEBHOOK_SECRET: "old-secret",
};

test("credenciais antigas são separadas das ativas e não herdam override de URL", () => {
  const old = gatewayForKind("beehive", env);
  assert.equal(old.apiKey, "old-key");
  assert.equal(old.createUrl, "https://api.conta.paybeehive.com.br/v1/transactions");
  assert.equal(old.webhookSecret, "old-secret");
  assert.equal(gatewayForKind("unknown", env), null);
  assert.equal(gatewayForKind("velani", env), null);
});

test("consulta encontra cobrança antiga sem gateway informado", async (t) => {
  t.mock.method(globalThis, "fetch", async (url) =>
    url.includes("paybeehive")
      ? Response.json({ id: "282", status: "paid", amount: 1234 })
      : Response.json({}, { status: 404 }),
  );
  const match = await lookupPayment("282", "", env);
  assert.equal(match?.gateway.kind, "beehive");
  assert.equal(match?.info.paid, true);
});

test("gateway explícito nunca usa credencial de outro e IDs ambíguos não liberam", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", async () =>
    Response.json({ id: "282", status: "paid", amount: 1234 }),
  );
  assert.equal(await lookupPayment("282", "", env), null);
  assert.equal((await lookupPayment("282", "beehive", env))?.gateway.kind, "beehive");
  const count = fetchMock.mock.calls.length;
  assert.equal(await lookupPayment("282", "typo", env), null);
  assert.equal(fetchMock.mock.calls.length, count);
});
