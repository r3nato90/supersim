import test from "node:test";
import assert from "node:assert/strict";
import { handleVelaniPaid } from "./velani-webhook.ts";
import { resolvePrimaryEnv } from "./pay-gateway.ts";

const gateway = resolvePrimaryEnv({ PIX_GATEWAY: "velani", PIX_GATEWAY_API_KEY: "sk_live_test" });

test("Velani webhook confirma na API e usa valor confirmado", async (t) => {
  t.mock.property(process, "env", { ...process.env, META_CAPI_TOKEN: "" });
  const mocked = t.mock.method(globalThis, "fetch", async () => Response.json({
    success: true, data: { id: "v1", status: "paid", amount: 1234 },
  }));
  assert.equal((await handleVelaniPaid("v1", 1234, gateway)).status, 200);
  assert.equal((await handleVelaniPaid("v1", 9999, gateway)).status, 422);
  assert.equal(mocked.mock.calls.length, 2);
});

test("Velani webhook pede reentrega em indisponibilidade/pendência, ignora terminal", async (t) => {
  t.mock.property(process, "env", { ...process.env, META_CAPI_TOKEN: "" });
  for (const [status, expected] of [["pending", 503], ["processing", 503], ["refunded", 200], ["expired", 200], ["failed", 200]]) {
    const mocked = t.mock.method(globalThis, "fetch", async () => Response.json({
      data: { id: "v1", status, amount: 1234 },
    }));
    assert.equal((await handleVelaniPaid("v1", 1234, gateway)).status, expected);
    mocked.mock.restore();
  }
  t.mock.method(globalThis, "fetch", async () => Response.json({}, { status: 503 }));
  assert.equal((await handleVelaniPaid("v1", 1234, gateway)).status, 503);
});

test("Velani webhook não confirma valor inválido nem perde falha CAPI com HTTP 200", async (t) => {
  t.mock.property(process, "env", { ...process.env, META_CAPI_TOKEN: "test-token" });
  t.mock.method(console, "error", () => {});
  let amount = 0;
  const mocked = t.mock.method(globalThis, "fetch", async (url) => {
    if (url.includes("velanipagamentos")) return Response.json({
      data: { id: "v1", status: "paid", amount },
    });
    return Response.json({ error: { message: "temporário" } }, { status: 503 });
  });
  assert.equal((await handleVelaniPaid("v1", undefined, gateway)).status, 503);
  assert.equal(mocked.mock.calls.length, 1);
  amount = 1234;
  assert.equal((await handleVelaniPaid("v1", 1234, gateway)).status, 503);
  assert.equal(mocked.mock.calls.length, 3);
});
