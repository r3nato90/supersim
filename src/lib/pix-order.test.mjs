import test from "node:test";
import assert from "node:assert/strict";
import { createPixCreationGuard, pixOrderReference, referenceBelongsToOrder } from "./pix-order.ts";
import { resolvePrimaryEnv } from "./pay-gateway.ts";

const env = resolvePrimaryEnv({ PIX_GATEWAY: "velani", PIX_GATEWAY_API_KEY: "sk_live_mock_only" });
const reference = () => pixOrderReference("11144477735", "front", 2863, env);

test("referência: documento/produto/valor/conta têm identidade estável sem CPF exposto", async () => {
  const first = await reference();
  assert.equal(first, await reference());
  assert.match(first, /^pix_[a-f0-9]{40}$/);
  assert.ok(!first.includes("11144477735"));
  for (const changed of [
    pixOrderReference("52998224725", "front", 2863, env),
    pixOrderReference("11144477735", "up1", 2863, env),
    pixOrderReference("11144477735", "front", 1000, env),
    pixOrderReference("11144477735", "front", 2863, { ...env, apiKey: "another-account" }),
  ])
    assert.notEqual(first, await changed);
});

test("referência: renovação estável, vinculada à compra e à transação expirada", async () => {
  const base = await reference();
  const renewal = await pixOrderReference("11144477735", "front", 2863, env, "expired-1");
  assert.equal(renewal, await pixOrderReference("11144477735", "front", 2863, env, "expired-1"));
  assert.notEqual(renewal, await pixOrderReference("11144477735", "front", 2863, env, "expired-2"));
  assert.ok(referenceBelongsToOrder(base, base));
  assert.ok(referenceBelongsToOrder(renewal, base));
  assert.ok(!referenceBelongsToOrder(`${base}_anything`, base));
  assert.ok(!referenceBelongsToOrder(`${base}_` + "a".repeat(25), base));
  assert.ok(
    !referenceBelongsToOrder(await pixOrderReference("52998224725", "front", 2863, env), base),
  );
});

test("guard: 100 concorrentes executam uma operação e preservam corpo/createdAt no replay", async () => {
  const guard = createPixCreationGuard();
  let calls = 0;
  const operation = async () => {
    calls++;
    return Response.json({ success: true, txnId: "one", createdAt: "fixed" }, { status: 201 });
  };
  const responses = await Promise.all(Array.from({ length: 100 }, () => guard("same", operation)));
  assert.equal(calls, 1);
  for (const response of responses)
    assert.deepEqual(await response.json(), { success: true, txnId: "one", createdAt: "fixed" });
  assert.equal((await guard("same", operation)).status, 201);
  assert.equal(calls, 1);
});

test("guard: exceção conserva estado desconhecido e nunca repete a operação", async () => {
  const guard = createPixCreationGuard();
  let calls = 0;
  const operation = async () => {
    calls++;
    throw new Error("timeout");
  };
  assert.equal((await guard("same", operation)).status, 502);
  assert.equal((await guard("same", operation)).status, 502);
  assert.equal((await guard("same", operation, true)).status, 502);
  assert.equal(calls, 1);
});

test("guard: recuperação desconhecida falha fechada sem executar criação", async () => {
  const guard = createPixCreationGuard();
  const response = await guard(
    "missing",
    () => {
      throw new Error("não deveria criar");
    },
    true,
  );
  assert.equal(response.status, 409);
  assert.equal((await response.json()).safeToRetry, false);
});

test("guard: capacidade cheia não expulsa uma cobrança incerta para liberar nova criação", async () => {
  const guard = createPixCreationGuard({ maxEntries: 1 });
  await guard("first", async () => {
    throw new Error("timeout");
  });
  const denied = await guard("second", async () => {
    throw new Error("não deveria criar");
  });
  assert.equal(denied.status, 503);
  assert.equal((await denied.json()).safeToRetry, true);
  assert.equal((await guard("first", async () => Response.json({ success: true }))).status, 502);
});

test("guard: uma operação em andamento não é removida pelo TTL", async () => {
  let now = 0;
  let finish;
  const wait = new Promise((resolve) => {
    finish = resolve;
  });
  const guard = createPixCreationGuard({ now: () => now, retentionMs: 10, maxEntries: 1 });
  const first = guard("first", async () => {
    await wait;
    return Response.json({ success: true });
  });
  now = 100;
  assert.equal((await guard("second", async () => Response.json({ success: true }))).status, 503);
  finish();
  assert.equal((await first).status, 200);
});
