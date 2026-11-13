import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { webcrypto } from "node:crypto";
import ts from "typescript";
import { z } from "zod";
import { cpfValido } from "./cpf-brasil.ts";
import * as gateway from "./pay-gateway.ts";
import { PRODUCTS } from "./sup-products.ts";
import * as pixOrder from "./pix-order.ts";

const routeSource = readFileSync(
  new URL("../routes/api/public/sup-pix.ts", import.meta.url),
  "utf8",
);
// Executa o handler POST real, sem iniciar HTTP/TanStack. Apenas o registro da
// rota, configuração e serviços externos são substituídos. Não lê env real.
const routeJs = ts.transpileModule(routeSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function harness(
  t,
  {
    failFirstAfterCreation = false,
    status = 200,
    honorIdempotency = true,
    previousStatus = "expired",
    previousAmount = 2863,
    previousReference,
    statusUnavailable = false,
  } = {},
) {
  const env = gateway.resolvePrimaryEnv({
    PIX_GATEWAY: "velani",
    PIX_GATEWAY_API_KEY: "sk_live_mock_only",
  });
  const calls = [];
  const charges = new Map();
  const lookups = [];
  let timestamps = 0;
  t.mock.method(console, "error", () => {});
  // O provedor SIMULADO honra a chave. Isso mede a proteção da nossa rota,
  // não prova que a API real da Velani honra idempotência/concorrência.
  t.mock.method(globalThis, "fetch", async (url, init) => {
    if (init.method === "GET") {
      assert.equal(url, env.statusUrl.replace("{id}", "previous-mock"));
      lookups.push(url);
      if (statusUnavailable) return Response.json({}, { status: 503 });
      return Response.json({
        success: true,
        data: {
          id: "previous-mock",
          status: previousStatus,
          amount: previousAmount,
          externalId:
            previousReference ??
            (await pixOrder.pixOrderReference("11144477735", "front", 2863, env)),
        },
      });
    }
    assert.equal(url, env.createUrl);
    assert.equal(init.method, "POST");
    const key = init.headers["x-idempotency-key"];
    assert.match(key, /^[a-f0-9]{64}$/);
    calls.push({ key, body: JSON.parse(init.body) });
    if (status >= 400) return Response.json({ message: "falha simulada" }, { status });
    const chargeKey = honorIdempotency ? key : `${key}:${calls.length}`;
    if (!charges.has(chargeKey)) {
      charges.set(chargeKey, {
        id: `pending-mock-${charges.size + 1}`,
        status: "pending",
        pixQrCode: "000201-mock",
        expiresAt: new Date(Date.now() + 1800000).toISOString(),
      });
    }
    if (failFirstAfterCreation && calls.length === 1) {
      throw new Error("resposta perdida após criar cobrança simulada");
    }
    return Response.json({ success: true, data: charges.get(chargeKey) });
  });

  const dependencies = {
    "@tanstack/react-router": { createFileRoute: () => (config) => config },
    zod: { z },
    "../../../lib/cpf-brasil": { cpfValido },
    "../../../lib/meta-capi": {
      getClientIp: () => "",
      sendMetaCapiEvent: async () => {
        throw new Error("CAPI não deve ser chamada");
      },
    },
    "../../../lib/pay-gateway": {
      ...gateway,
      resolvePrimaryEnv: () => ({ ...env }),
      runBackground: async (promise) => {
        await promise;
      },
    },
    "../../../lib/sup-products": { PRODUCTS },
    "../../../lib/pix-order": pixOrder,
    "../../../lib/utmify": {
      resolveUtmifyEnv: () => ({ token: "" }),
      sendUtmifyOrder: async () => {
        throw new Error("UTMify não deve ser chamada");
      },
      utcTimestamp: () => "2026-10-21 15:00:" + String(++timestamps).padStart(2, "0"),
    },
    "../../../lib/payment-context": {
      sealPaymentContext: async () => {
        throw new Error("Contexto Pague-X não deve ser chamado");
      },
    },
  };
  function instance() {
    const exports = {};
    const context = vm.createContext({
      exports,
      require: (id) => {
        assert.ok(Object.hasOwn(dependencies, id), `Dependência não simulada: ${id}`);
        return dependencies[id];
      },
      Request,
      Response,
      URL,
      crypto: webcrypto,
      console,
      process: { env: {} },
    });
    vm.runInContext(routeJs, context, { filename: "sup-pix.test.cjs" });
    const post = exports.Route.server.handlers.POST;
    async function request(overrides = {}) {
      const response = await post({
        request: new Request("https://loja.test/api/public/sup-pix", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            upKey: "seguro",
            nome: "Cliente de teste",
            cpf: "11144477735",
            email: "teste@example.com",
            phone: "11999999999",
            clientOrderId: "order-fixed-test",
            ...overrides,
          }),
        }),
      });
      return { status: response.status, data: await response.json() };
    }
    return request;
  }
  return { request: instance(), newInstance: instance, calls, charges, lookups };
}

test("sup-pix: 25 chamadas concorrentes produzem somente um POST na mesma instância", async (t) => {
  const { request, calls, charges } = harness(t);
  const results = await Promise.all(Array.from({ length: 25 }, () => request()));
  assert.ok(results.every(({ status, data }) => status === 201 && data.status === "pending"));
  assert.equal(calls.length, 1);
  assert.equal(new Set(calls.map((call) => call.key)).size, 1);
  assert.equal(charges.size, 1);
  assert.equal(new Set(results.map(({ data }) => data.txnId)).size, 1);
});

test("sup-pix: referências diferentes do navegador não duplicam a mesma compra", async (t) => {
  const { request, calls, charges } = harness(t);
  const results = await Promise.all(
    Array.from({ length: 3 }, (_, i) => request({ clientOrderId: `order-new-${i}` })),
  );
  assert.ok(results.every(({ data }) => data.status === "pending"));
  assert.equal(calls.length, 1);
  assert.equal(charges.size, 1);
});

test("sup-pix: dois pedidos idênticos não duplicam mesmo se o gateway ignorar a chave", async (t) => {
  const { request, calls, charges } = harness(t, { honorIdempotency: false });
  const results = await Promise.all([request(), request()]);
  assert.equal(calls.length, 1);
  assert.equal(charges.size, 1);
  assert.equal(results[0].data.txnId, results[1].data.txnId);
  assert.ok(results.every(({ data }) => data.status === "pending"));
});

for (const reference of [undefined, "", "short"]) {
  test(`sup-pix: referência ${JSON.stringify(reference)} é rejeitada sem criar cobrança`, async (t) => {
    const { request, calls, charges } = harness(t);
    for (let i = 0; i < 3; i++)
      assert.equal((await request({ clientOrderId: reference })).status, 422);
    assert.equal(calls.length, 0);
    assert.equal(charges.size, 0);
  });
}

for (const change of [
  { email: "outro@example.com" },
  { email: "TESTE@example.com" },
  { nome: "Cliente de Teste" },
  { phone: "11888888888" },
]) {
  test(`sup-pix: corrigir ${JSON.stringify(change)} não muda a compra nem cria outro PIX`, async (t) => {
    const { request, calls, charges } = harness(t);
    await request();
    await request(change);
    assert.equal(calls.length, 1);
    assert.equal(charges.size, 1);
  });
}

test("sup-pix: formatação equivalente de CPF/telefone não muda a chave", async (t) => {
  const { request, calls, charges } = harness(t);
  await request();
  await request({ cpf: "111.444.777-35", phone: "+5511999999999", email: " teste@example.com " });
  assert.equal(calls.length, 1);
  assert.equal(charges.size, 1);
});

test("sup-pix: produtos diferentes não colidem na idempotência", async (t) => {
  const { request, charges } = harness(t);
  assert.equal((await request()).status, 201);
  assert.equal((await request({ upKey: "up1" })).status, 201);
  assert.equal(charges.size, 2);
});

test("sup-pix: dados inválidos não chegam ao gateway e permitem correção", async (t) => {
  const { request, calls } = harness(t);
  for (const overrides of [
    { cpf: "00000000000" },
    { upKey: "inexistente" },
    { clientOrderId: "a".repeat(81) },
  ]) {
    const result = await request(overrides);
    assert.equal(result.status, 422);
    assert.equal(result.data.safeToRetry, true);
  }
  assert.equal(calls.length, 0);
});

for (const status of [400, 401, 422, 424, 429, 500, 503]) {
  test(`sup-pix: HTTP ${status} da Velani não dispara retry automático`, async (t) => {
    const { request, calls } = harness(t, { status });
    const response = await request();
    assert.equal(response.status, status);
    assert.notEqual(response.data.safeToRetry, true);
    assert.equal(calls.length, 1);
  });
}

test("sup-pix: resposta perdida após criar pendente não dispara outro POST automático", async (t) => {
  const { request, calls, charges } = harness(t, { failFirstAfterCreation: true });
  const result = await request();
  assert.equal(result.status, 502);
  assert.notEqual(result.data.safeToRetry, true);
  assert.equal(calls.length, 1);
  assert.equal(charges.size, 1);
});

test("sup-pix: resultado incerto não permite outro POST na mesma instância", async (t) => {
  const { request, calls, charges } = harness(t, { failFirstAfterCreation: true });
  assert.equal((await request()).status, 502);
  assert.equal((await request()).status, 502);
  assert.equal(calls.length, 1);
  assert.equal(charges.size, 1);
});

test("sup-pix: trocar a referência após timeout não contorna o bloqueio", async (t) => {
  const { request, calls, charges } = harness(t, { failFirstAfterCreation: true });
  assert.equal((await request()).status, 502);
  assert.equal((await request({ clientOrderId: "order-after-timeout" })).status, 502);
  assert.equal(calls.length, 1);
  assert.equal(charges.size, 1);
});

test("sup-pix: recuperar resposta existente reaproveita ID e createdAt sem POST", async (t) => {
  const { request, calls } = harness(t);
  const first = await request();
  const recovered = await request({ recoverOnly: true });
  assert.deepEqual(recovered, first);
  assert.equal(calls.length, 1);
});

test("sup-pix: recuperar pendência ausente nesta instância nunca cria outro PIX", async (t) => {
  const { request, calls } = harness(t);
  assert.equal((await request({ recoverOnly: true })).status, 409);
  assert.equal(calls.length, 0);
});

test("sup-pix LIMITE DISTRIBUÍDO: instâncias independentes dependem da deduplicação externa", async (t) => {
  const { request, newInstance, calls, charges } = harness(t, { honorIdempotency: false });
  await Promise.all([request(), newInstance()()]);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].key, calls[1].key);
  assert.equal(charges.size, 2);
});

test("sup-pix: dez renovações do mesmo PIX expirado criam só uma nova transação", async (t) => {
  const { request, calls, charges, lookups } = harness(t, { honorIdempotency: false });
  const results = await Promise.all(
    Array.from({ length: 10 }, () => request({ renewFromTxnId: "previous-mock" })),
  );
  assert.ok(results.every(({ status }) => status === 201));
  assert.equal(calls.length, 1);
  assert.equal(charges.size, 1);
  assert.equal(lookups.length, 10);
  assert.match(calls[0].body.externalId, /^pix_[a-f0-9]{40}_[a-f0-9]{24}$/);
});

for (const previousStatus of ["paid", "pending", "processing", "failed", "refunded", "unknown"]) {
  test(`sup-pix: status anterior ${previousStatus} não autoriza renovação`, async (t) => {
    const { request, calls } = harness(t, { previousStatus });
    assert.equal((await request({ renewFromTxnId: "previous-mock" })).status, 409);
    assert.equal(calls.length, 0);
  });
}

for (const options of [
  { previousReference: "another-order" },
  { previousAmount: 1000 },
  { statusUnavailable: true },
]) {
  test(`sup-pix: renovação recusa prova inválida ${JSON.stringify(options)}`, async (t) => {
    const { request, calls } = harness(t, options);
    assert.equal((await request({ renewFromTxnId: "previous-mock" })).status, 409);
    assert.equal(calls.length, 0);
  });
}
