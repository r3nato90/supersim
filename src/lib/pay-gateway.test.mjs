import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  buildPrimaryPayload,
  isPrimaryPaid,
  normalizePrimaryCreate,
  normalizePrimaryInfo,
  primaryCreate,
  primaryStatus,
  isPrimarySuccess,
  primaryErrorMessage,
  resolvePrimaryEnv,
  verifyWebhookSignature,
  webhookSignatureRequired,
} from "./pay-gateway.ts";

test("Pague-X: contrato de criação, documento string e telefone nacional", async (t) => {
  const env = resolvePrimaryEnv({
    PIX_GATEWAY: "paguex",
    PIX_GATEWAY_API_KEY: "sk_live_test",
    PIX_GATEWAY_POSTBACK_URL: "https://loja.test/api/public/sup-webhook",
  });
  assert.equal(env.configured, true);
  assert.equal(env.minAmountCents, 0);
  const mocked = t.mock.method(globalThis, "fetch", async () =>
    Response.json(
      {
        id: "charge-test",
        status: "pending",
        amount: 1234,
        pix: { copiaECola: "000201-test", qrCodeUrl: "https://image.test" },
      },
      { status: 201 },
    ),
  );
  const result = await primaryCreate(
    {
      amount: 1234,
      customer: {
        name: "Cliente",
        email: "cliente@example.com",
        phone: "5511999999999",
        document: { number: "111.444.777-35" },
      },
      items: [{ title: "Pedido" }],
      metadata: { order_id: "pedido-test" },
    },
    env,
  );
  const [url, init] = mocked.mock.calls[0].arguments;
  assert.equal(url, "https://api.pague-x.com.br/v1/charges");
  assert.equal(init.headers.Authorization, "Bearer sk_live_test");
  assert.equal(init.headers["X-API-Key"], undefined);
  assert.deepEqual(JSON.parse(init.body), {
    amount: 1234,
    currency: "BRL",
    paymentMethod: "pix",
    customer: {
      name: "Cliente",
      email: "cliente@example.com",
      document: "11144477735",
      phone: "11999999999",
    },
    reference: "pedido-test",
    description: "Pedido",
    postbackUrl: env.postbackUrl,
  });
  assert.equal(normalizePrimaryCreate(result.data)?.qrCode, "000201-test");
});

test("Pague-X: somente paid confirma, revisão/autorização nunca liberam", () => {
  for (const status of [
    "pending",
    "authorized",
    "under_review",
    "refused",
    "refunded",
    "chargeBack",
    "canceled",
    "expired",
    "unknown",
  ]) {
    assert.equal(
      normalizePrimaryInfo(
        { id: "c", status, paid: true, paidAt: "2026-10-20T00:00:00Z" },
        "c",
        "paguex",
      )?.paid,
      false,
      status,
    );
  }
  const info = normalizePrimaryInfo(
    { id: "c", status: "paid", amount: 1234, endToEndId: "E-test" },
    "c",
    "paguex",
  );
  assert.equal(info?.paid, true);
  assert.equal(info?.amount, 1234);
  assert.equal(info?.end2EndId, "E-test");
});

test("Pague-X: HMAC valida corpo bruto e rejeita adulteração", async () => {
  const raw = '{ "event": "sale.paid", "data": {"saleId":"c","status":"paid"} }';
  const sig = "sha256=" + crypto.createHmac("sha256", "whsec_test").update(raw).digest("hex");
  assert.equal(webhookSignatureRequired("paguex"), true);
  assert.equal(await verifyWebhookSignature(raw, sig, "whsec_test", "paguex"), true);
  assert.equal(await verifyWebhookSignature(raw + " ", sig, "whsec_test", "paguex"), false);
  assert.equal(await verifyWebhookSignature(raw, null, "whsec_test", "paguex"), false);
});

test("Pague-X: não repete POST em timeout nem 5xx", async (t) => {
  const env = resolvePrimaryEnv({ PIX_GATEWAY: "paguex", PIX_GATEWAY_API_KEY: "sk_live_test" });
  const mocked = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("timeout");
  });
  await assert.rejects(primaryCreate({ amount: 1234 }, env), /timeout/);
  assert.equal(mocked.mock.calls.length, 1);
  mocked.mock.mockImplementation(async () =>
    Response.json({ message: "indisponível" }, { status: 503 }),
  );
  t.mock.method(console, "error", () => {});
  assert.equal((await primaryCreate({ amount: 1234 }, env)).httpStatus, 503);
  assert.equal(mocked.mock.calls.length, 2);
});

test("consulta rejeita id divergente e gateway não configurado não chama API", async (t) => {
  const mocked = t.mock.method(globalThis, "fetch", async () =>
    Response.json({ id: "outro", status: "paid" }),
  );
  assert.equal(await primaryStatus("c", resolvePrimaryEnv({ PIX_GATEWAY: "paguex" })), null);
  assert.equal(mocked.mock.calls.length, 0);
  assert.equal(
    await primaryStatus(
      "c",
      resolvePrimaryEnv({ PIX_GATEWAY: "paguex", PIX_GATEWAY_API_KEY: "test" }),
    ),
    null,
  );
  assert.equal(mocked.mock.calls[0].arguments[0], "https://api.pague-x.com.br/v1/charges/c");
});

test("success false na raiz não é ocultado por data", () => {
  assert.equal(isPrimarySuccess(200, { success: false, data: { status: "paid" } }), false);
});

test("normalizePrimaryCreate aceita somente pix_qrcode (resposta padrão v2.8)", () => {
  const normalized = normalizePrimaryCreate({
    success: true,
    transaction_id: "vxg_uuid",
    status: "pending",
    pix_qrcode: "000201...",
  });
  assert.ok(normalized);
  assert.equal(normalized?.id, "vxg_uuid");
  assert.equal(normalized?.qrCode, "000201...");
});

test("normalizePrimaryCreate aceita aliases legados", () => {
  const normalized = normalizePrimaryCreate({
    transaction_id: "vxg_uuid",
    copy_paste: "000201...",
  });
  assert.equal(normalized?.qrCode, "000201...");
});

test("status contraditório (pending/failed + paid_at) nunca conta como pago", () => {
  for (const status of ["pending", "processing", "failed", "rejected", "cancelled", "expired"]) {
    assert.equal(isPrimaryPaid(status, "2026-10-14T00:00:00-03:00"), false, status);
    assert.equal(isPrimaryPaid(status, "2026-10-14T00:00:00-03:00", true), false, `${status}+flag`);
  }
});

test("status pago confirma pagamento", () => {
  for (const status of ["paid", "completed", "approved", "confirmed"]) {
    assert.equal(isPrimaryPaid(status, ""), true, status);
  }
});

test("normalizePrimaryInfo respeita semântica documentada", () => {
  const info = normalizePrimaryInfo(
    { transaction_id: "t1", status: "pending", paid_at: "2026-10-14T00:00:00-03:00" },
    "t1",
    "vexigate",
  );
  assert.ok(info);
  assert.equal(info?.paid, false);
});

test("resolvePrimaryEnv usa domínio indicado pelo suporte e piso R$10,00", () => {
  const env = resolvePrimaryEnv({ PIX_GATEWAY_API_KEY: "vxg_live_x" });
  assert.equal(env.kind, "vexigate");
  assert.equal(env.createUrl, "https://vexigate.com/api/v1/payments/pix");
  assert.equal(env.statusUrl, "https://vexigate.com/api/v1/payments/{id}");
  assert.equal(env.minAmountCents, 1000);
});

test("PIX_GATEWAY desconhecido nao cai no vexigate em silencio", (t) => {
  const log = t.mock.method(console, "error", () => {});
  const env = resolvePrimaryEnv({
    PIX_GATEWAY: "velany", // typo
    PIX_GATEWAY_API_KEY: "sk_live_x",
  });
  assert.equal(env.configured, false, "typo deve desativar o gateway, nao rotear pro vexigate");
  assert.equal(env.createUrl, "");
  assert.equal(log.mock.calls.length, 1);
  assert.match(String(log.mock.calls[0].arguments[0]), /PIX_GATEWAY com valor desconhecido/);
});

test("PIX_GATEWAY vazio continua no default vexigate", () => {
  const env = resolvePrimaryEnv({ PIX_GATEWAY: "  ", PIX_GATEWAY_API_KEY: "vxg_live_x" });
  assert.equal(env.kind, "vexigate");
  assert.equal(env.configured, true);
});

test("avisa quando o override de URL aponta para outro gateway", (t) => {
  const log = t.mock.method(console, "error", () => {});
  // Bug real de producao: kind=velani mas CREATE_URL do vexigate -> payload
  // da Velani enviado no endereco do Vexigate (401 "API Key ausente ou invalida").
  const env = resolvePrimaryEnv({
    PIX_GATEWAY: "velani",
    PIX_GATEWAY_API_KEY: "sk_live_x",
    PIX_GATEWAY_CREATE_URL: "https://vexigate.com/api/v1/payments/pix",
  });
  assert.equal(env.kind, "velani");
  assert.equal(env.createUrl, "https://vexigate.com/api/v1/payments/pix");
  assert.equal(env.configured, false);
  assert.equal(log.mock.calls.length, 1);
  assert.match(String(log.mock.calls[0].arguments[0]), /aponta para outro gateway/);
});

test("sem override, velani usa a URL propria e nao avisa", (t) => {
  const log = t.mock.method(console, "error", () => {});
  const env = resolvePrimaryEnv({ PIX_GATEWAY: "velani", PIX_GATEWAY_API_KEY: "sk_live_x" });
  assert.equal(
    env.createUrl,
    "https://api.velanipagamentos.com.br/api/v1/api-gateway/v1/transactions",
  );
  assert.equal(log.mock.calls.length, 0);
});

test("criação envia Bearer, User-Agent e no-store conforme suporte", async (t) => {
  const mocked = t.mock.method(globalThis, "fetch", async () =>
    Response.json({ success: true, transaction_id: "test", copy_paste: "000201" }),
  );
  await primaryCreate({ amount: 1432 }, resolvePrimaryEnv({ PIX_GATEWAY_API_KEY: "test-key" }));
  const [url, init] = mocked.mock.calls[0].arguments;
  assert.equal(url, "https://vexigate.com/api/v1/payments/pix");
  assert.equal(init.method, "POST");
  assert.equal(init.headers.Authorization, "Bearer test-key");
  assert.equal(init.headers["User-Agent"], "funil-supersim/1.0");
  assert.equal(init.headers.Accept, "application/json");
  assert.equal(init.headers["Content-Type"], "application/json");
  assert.equal(init.cache, "no-store");
  assert.equal(JSON.parse(init.body).amount, 14.32);
});

test("403 HTML não é descartado nem tratado como sucesso", async (t) => {
  t.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response("<html>Forbidden</html>", {
        status: 403,
        headers: { "content-type": "text/html", "cf-ray": "test-ray" },
      }),
  );
  const log = t.mock.method(console, "error", () => {});
  const result = await primaryCreate({}, resolvePrimaryEnv({ PIX_GATEWAY_API_KEY: "test-key" }));
  assert.equal(result.httpStatus, 403);
  assert.equal(result.data.success, false);
  assert.match(result.data.message, /403, resposta não JSON/);
  assert.equal(log.mock.calls[0].arguments[1].cfRay, "test-ray");
  assert.ok(!JSON.stringify(log.mock.calls).includes("test-key"));
});

// ─── Velani Pagamentos (API v1.0) ───

test("resolvePrimaryEnv reconhece velani com URLs e piso R$5,00", () => {
  const env = resolvePrimaryEnv({ PIX_GATEWAY: "velani", PIX_GATEWAY_API_KEY: "sk_live_x" });
  assert.equal(env.kind, "velani");
  assert.equal(
    env.createUrl,
    "https://api.velanipagamentos.com.br/api/v1/api-gateway/v1/transactions",
  );
  assert.equal(
    env.statusUrl,
    "https://api.velanipagamentos.com.br/api/v1/api-gateway/v1/transactions/{id}",
  );
  assert.equal(env.minAmountCents, 500);
});

test("payload velani usa amount em centavos, camelCase e tracking", () => {
  const env = resolvePrimaryEnv({
    PIX_GATEWAY: "velani",
    PIX_GATEWAY_API_KEY: "sk_live_x",
    PIX_GATEWAY_POSTBACK_URL: "https://loja.test/api/public/sup-webhook",
  });
  const body = buildPrimaryPayload(
    {
      amount: 2863,
      customer: {
        name: "João Silva",
        email: "joao@email.com",
        phone: "11999999999",
        document: { type: "cpf", number: "12345678900" },
      },
      items: [{ title: "Creme Hidratante Intensivo", unit_price: 2863, quantity: 1 }],
      metadata: { order_id: "order_abc", product_key: "seguro", utm_source: "facebook" },
    },
    env,
  );
  assert.equal(body.paymentMethod, "pix");
  assert.equal(body.amount, 2863);
  assert.deepEqual(body.customer, {
    name: "João Silva",
    email: "joao@email.com",
    phone: "11999999999",
    document: { type: "cpf", number: "12345678900" },
  });
  assert.deepEqual(body.items, [
    { title: "Creme Hidratante Intensivo", unitPrice: 2863, quantity: 1 },
  ]);
  assert.equal(body.externalId, "order_abc");
  assert.equal(body.postbackUrl, "https://loja.test/api/public/sup-webhook");
  assert.equal(body.tracking.utm_source, "facebook");
  assert.equal(body.tracking.product_key, undefined);
});

test("criação velani envia somente x-api-key (sem Bearer)", async (t) => {
  const mocked = t.mock.method(globalThis, "fetch", async () =>
    Response.json({
      success: true,
      data: {
        id: "uuid-1",
        status: "pending",
        amount: 2863,
        pixQrCode: "00020126580014br.gov.bcb.pix",
        pixQrCodeImage: "https://api.velanipagamentos.com.br/qrcode/xxx.png",
        expiresAt: "2026-01-15T11:00:00.000Z",
      },
    }),
  );
  const env = resolvePrimaryEnv({ PIX_GATEWAY: "velani", PIX_GATEWAY_API_KEY: "sk_live_test" });
  const result = await primaryCreate({ amount: 2863 }, env);
  const [url, init] = mocked.mock.calls[0].arguments;
  assert.equal(url, env.createUrl);
  assert.equal(init.headers["x-api-key"], "sk_live_test");
  assert.equal(init.headers.Authorization, undefined);
  const created = normalizePrimaryCreate(result.data);
  assert.equal(created?.id, "uuid-1");
  assert.equal(created?.qrCode, "00020126580014br.gov.bcb.pix");
  assert.equal(created?.expirationDate, "2026-01-15T11:00:00.000Z");
});

test("normalizePrimaryInfo mantém amount em centavos e reconhece paid", () => {
  const info = normalizePrimaryInfo(
    {
      success: true,
      data: {
        id: "uuid-1",
        externalId: "order_abc",
        status: "paid",
        amount: 2863,
        paymentMethod: "pix",
        createdAt: "2026-01-15T10:30:00.000Z",
      },
    },
    "uuid-1",
    "velani",
  );
  assert.ok(info);
  assert.equal(info?.paid, true);
  assert.equal(info?.amount, 2863);
});

test("mensagem de erro velani vem de error.message", () => {
  const message = primaryErrorMessage(
    { success: false, error: { message: "Valor mínimo: R$ 1,00 (100 centavos)", statusCode: 400 } },
    "fallback",
  );
  assert.equal(message, "Valor mínimo: R$ 1,00 (100 centavos)");
});

test("mensagem de erro velani (shape real: message na raiz, error string)", () => {
  // Observado em conta real: { message, error: "Bad Request", statusCode }
  const message = primaryErrorMessage(
    { message: "Valor mínimo: R$ 5,00 (500 centavos)", error: "Bad Request", statusCode: 400 },
    "fallback",
  );
  assert.equal(message, "Valor mínimo: R$ 5,00 (500 centavos)");
});

test("webhook velani valida HMAC de JSON.stringify(data)", async () => {
  const secret = "whsec_test";
  const payload = {
    event: "transaction.paid",
    timestamp: "2026-01-15T10:35:00.000Z",
    data: { id: "uuid-1", externalId: "order_abc", amount: 2863, status: "paid" },
    version: "1.0",
    source: "velani-gateway",
  };
  const signature = crypto
    .createHmac("sha256", secret)
    .update(JSON.stringify(payload.data))
    .digest("hex");
  const rawBody = JSON.stringify(payload);

  assert.equal(await verifyWebhookSignature(rawBody, signature, secret, "velani"), true);
  assert.equal(await verifyWebhookSignature(rawBody, "deadbeef", secret, "velani"), false);
  assert.equal(await verifyWebhookSignature(rawBody, signature, "", "velani"), false);
  // Assinatura do corpo bruto (formato vexigate) NÃO vale para velani.
  const rawSig = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  assert.equal(await verifyWebhookSignature(rawBody, rawSig, secret, "velani"), false);
});

test("webhook vexigate continua validando o corpo bruto", async () => {
  const secret = "whsec_test";
  const rawBody = JSON.stringify({ transaction_id: "t1", status: "paid" });
  const signature = `sha256=${crypto.createHmac("sha256", secret).update(rawBody).digest("hex")}`;
  assert.equal(await verifyWebhookSignature(rawBody, signature, secret), true);
  assert.equal(await verifyWebhookSignature(rawBody, signature, secret, "vexigate"), true);
});

// ─── Beehive Pay (docs.beehivehub.io) ───
test("Velani bloqueia override de consulta inseguro e não vaza URL no log", (t) => {
  const log = t.mock.method(console, "error", () => {});
  for (const url of ["https://outro.test/{id}", "http://api.velanipagamentos.com.br/{id}"]) {
    assert.equal(resolvePrimaryEnv({
      PIX_GATEWAY: "velani", PIX_GATEWAY_API_KEY: "sk_live_test",
      PIX_GATEWAY_STATUS_URL: url,
    }).configured, false);
  }
  resolvePrimaryEnv({
    PIX_GATEWAY: "velani", PIX_GATEWAY_API_KEY: "sk_live_test",
    PIX_GATEWAY_CREATE_URL: "https://outro.test/?ctx=secret-context",
  });
  assert.ok(!JSON.stringify(log.mock.calls).includes("secret-context"));
});

test("Velani exige Secret Key na criação, sem fazer requisição com Public Key", async (t) => {
  const mocked = t.mock.method(globalThis, "fetch", async () => Response.json({}));
  await assert.rejects(primaryCreate({ amount: 1000 }, resolvePrimaryEnv({
    PIX_GATEWAY: "velani", PIX_GATEWAY_API_KEY: "pk_live_test",
  })), /Secret Key/);
  assert.equal(mocked.mock.calls.length, 0);
});

test("Velani idempotência é estável, separa produtos e não repete POST em falha", async (t) => {
  const env = resolvePrimaryEnv({ PIX_GATEWAY: "velani", PIX_GATEWAY_API_KEY: "sk_live_test" });
  const mocked = t.mock.method(globalThis, "fetch", async () => Response.json({ data: {} }));
  const payload = { amount: 1000, customer: { name: "Cliente" }, metadata: { order_id: "order-test" } };
  await primaryCreate(payload, env);
  await primaryCreate(payload, { ...env, postbackUrl: "https://loja.test/?ctx=changed" });
  await primaryCreate({ ...payload, amount: 2000 }, env);
  const keys = mocked.mock.calls.map(({ arguments: [, init] }) => {
    assert.equal(init.redirect, "error");
    return init.headers["x-idempotency-key"];
  });
  assert.match(keys[0], /^[a-f0-9]{64}$/);
  assert.equal(keys[0], keys[1]);
  assert.notEqual(keys[0], keys[2]);
  mocked.mock.mockImplementation(async () => { throw new Error("timeout"); });
  await assert.rejects(primaryCreate(payload, env), /timeout/);
  assert.equal(mocked.mock.calls.length, 4);
});

test("Velani normaliza telefone nacional e omite número inválido", () => {
  const env = resolvePrimaryEnv({ PIX_GATEWAY: "velani", PIX_GATEWAY_API_KEY: "sk_live_test" });
  for (const [phone, expected] of [["5511999999999", "11999999999"], ["55999999999", "55999999999"], ["20999999999", undefined]]) {
    const body = buildPrimaryPayload({ customer: { phone, document: { number: "111.444.777-35" } } }, env);
    assert.equal(body.customer.phone, expected);
    assert.equal(body.customer.document.number, "11144477735");
  }
});

test("Velani: mudar dados de contato não muda a chave da mesma referência", async (t) => {
  const env = resolvePrimaryEnv({ PIX_GATEWAY: "velani", PIX_GATEWAY_API_KEY: "sk_live_test" });
  const mocked = t.mock.method(globalThis, "fetch", async () => Response.json({ data: {} }));
  for (const customer of [
    { name: "Cliente", email: "cliente@example.com", phone: "11999999999" },
    { name: "Nome corrigido", email: "OUTRO@example.com", phone: "11888888888" },
  ]) await primaryCreate({ amount: 2863, customer, metadata: { order_id: "same-server-order" } }, env);
  assert.equal(mocked.mock.calls[0].arguments[1].headers["x-idempotency-key"], mocked.mock.calls[1].arguments[1].headers["x-idempotency-key"]);
});

test("Velani somente paid confirma, mesmo com flag/data contraditória", () => {
  for (const status of ["pending", "processing", "failed", "expired", "refunded", "unknown", "approved"]) {
    assert.equal(normalizePrimaryInfo({ data: {
      id: "v1", status, paid: true, paidAt: "2026-10-21T12:00:00Z",
    } }, "v1", "velani").paid, false, status);
  }
});

test("resolvePrimaryEnv reconhece beehive com URLs próprias", () => {
  const env = resolvePrimaryEnv({ PIX_GATEWAY: "beehive", PIX_GATEWAY_API_KEY: "sk_live_x" });
  assert.equal(env.kind, "beehive");
  assert.equal(env.createUrl, "https://api.conta.paybeehive.com.br/v1/transactions");
  assert.equal(env.statusUrl, "https://api.conta.paybeehive.com.br/v1/transactions/{id}");
  assert.equal(env.minAmountCents, 0);
});

test("payload beehive segue o contrato (centavos, metadata fixo, ip, tangible)", () => {
  const env = resolvePrimaryEnv({
    PIX_GATEWAY: "beehive",
    PIX_GATEWAY_API_KEY: "sk_live_x",
    PIX_GATEWAY_POSTBACK_URL: "https://loja.test/api/public/sup-webhook",
  });
  const body = buildPrimaryPayload(
    {
      amount: 2863,
      ip: "189.10.20.30",
      customer: {
        name: "João Silva",
        email: "joao@email.com",
        phone: "11999999999",
        document: { type: "cpf", number: "12345678900" },
      },
      items: [
        { title: "Creme Hidratante Intensivo", unit_price: 2863, quantity: 1, tangible: false },
      ],
      pix: { expires_in_days: 1 },
      metadata: {
        order_id: "order_abc",
        product_key: "seguro",
        shop_url: "https://loja.test",
        checkout_url: "https://loja.test/inicio",
      },
    },
    env,
  );
  assert.equal(body.paymentMethod, "pix");
  assert.equal(body.amount, 2863);
  assert.equal(body.ip, "189.10.20.30");
  assert.deepEqual(body.customer, {
    name: "João Silva",
    email: "joao@email.com",
    document: { type: "cpf", number: "12345678900" },
    phone: "+5511999999999",
  });
  assert.deepEqual(body.items, [
    { title: "Creme Hidratante Intensivo", unitPrice: 2863, quantity: 1, tangible: false },
  ]);
  assert.deepEqual(body.metadata, {
    provider: "funil-supersim",
    user_email: "joao@email.com",
    order_id: "order_abc",
    checkout_url: "https://loja.test/inicio",
    shop_url: "https://loja.test",
  });
  assert.equal(body.externalRef, "order_abc");
  assert.equal(body.postbackUrl, "https://loja.test/api/public/sup-webhook");
  assert.deepEqual(body.pix, { expiresInSeconds: 86400 });
  // UTMs não vão soltas no corpo da Beehive.
  assert.equal(body.utm_source, undefined);
});

test("payload beehive normaliza o telefone para E.164", () => {
  // Bug real de produção (19/10/2026): o funil manda `5511999999999` (país sem
  // `+`) e a Beehive responde 422 "customer.phone is invalid". E.164 passa.
  const env = resolvePrimaryEnv({ PIX_GATEWAY: "beehive", PIX_GATEWAY_API_KEY: "sk_live_x" });
  const cases = {
    5511999999999: "+5511999999999", // formato atual do funil
    11999999999: "+5511999999999", // DDD + celular
    1133334444: "+551133334444", // DDD + fixo
    "011999999999": "+5511999999999", // zero de discagem
    "+55 11 99999-9999": "+5511999999999", // já em E.164 com máscara
    55999999999: "+5555999999999", // DDD 55 (não confundir com país)
  };
  for (const [input, expected] of Object.entries(cases)) {
    const body = buildPrimaryPayload(
      { amount: 1000, customer: { name: "A", email: "a@b.com", phone: input } },
      env,
    );
    assert.equal(body.customer.phone, expected, input);
  }
});

test("payload beehive omite telefone impossível de normalizar", () => {
  const env = resolvePrimaryEnv({ PIX_GATEWAY: "beehive", PIX_GATEWAY_API_KEY: "sk_live_x" });
  const cases = [
    "",
    "119",
    "0000000000000",
    "9999999999999",
    // Bug real de produção (20/10/2026): DDD 55 + `888888888` (celular tem de
    // começar em 9) passava e virava `+5555588888888` → 422 e venda perdida.
    "55588888888",
    "5555588888888",
    // DDD inexistente (20, 26, 30...) também é recusado pela Beehive.
    "20999999999",
    "30999999999",
    // Celular de 10 dígitos (faltando o 9) não é fixo nem celular válido.
    "1199999999",
  ];
  for (const input of cases) {
    const body = buildPrimaryPayload(
      { amount: 1000, customer: { name: "A", email: "a@b.com", phone: input } },
      env,
    );
    assert.equal(body.customer.phone, undefined, input);
  }
});

test("criação beehive envia Basic base64(SECRET_KEY:x)", async (t) => {
  const mocked = t.mock.method(globalThis, "fetch", async () =>
    Response.json({ id: 282, status: "created", amount: 2863, qrCode: "00020126580014" }),
  );
  const env = resolvePrimaryEnv({ PIX_GATEWAY: "beehive", PIX_GATEWAY_API_KEY: "sk_live_test" });
  const result = await primaryCreate({ amount: 2863 }, env);
  const [url, init] = mocked.mock.calls[0].arguments;
  assert.equal(url, "https://api.conta.paybeehive.com.br/v1/transactions");
  assert.equal(
    init.headers.Authorization,
    `Basic ${Buffer.from("sk_live_test:x").toString("base64")}`,
  );
  assert.equal(init.headers["x-api-key"], undefined);
  const created = normalizePrimaryCreate(result.data);
  assert.equal(created?.id, "282");
  assert.equal(created?.qrCode, "00020126580014");
});

test("beehive repete com Bearer quando o Basic recebe 401", async (t) => {
  const schemes = [];
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    const auth = init.headers.Authorization;
    schemes.push(auth.split(" ")[0]);
    if (schemes.length === 1) return new Response("{}", { status: 401 });
    return Response.json({ id: 7, status: "created", qrCode: "000201" });
  });
  const env = resolvePrimaryEnv({ PIX_GATEWAY: "beehive", PIX_GATEWAY_API_KEY: "sk_live_test" });
  const result = await primaryCreate({ amount: 1000 }, env);
  assert.deepEqual(schemes, ["Basic", "Bearer"]);
  assert.equal(result.httpStatus, 200);
  assert.equal(result.data.id, 7);
});

test("normalizePrimaryInfo beehive mantém centavos e reconhece paid", () => {
  const info = normalizePrimaryInfo(
    { id: 282, status: "paid", amount: 2863, paidAt: "2026-10-18T09:54:22.000Z" },
    "282",
    "beehive",
  );
  assert.ok(info);
  assert.equal(info?.id, "282");
  assert.equal(info?.paid, true);
  assert.equal(info?.amount, 2863);
});

test("status refused/refunded da beehive nunca contam como pago", () => {
  for (const status of ["refused", "refunded", "chargeback"]) {
    assert.equal(isPrimaryPaid(status, "2026-10-18T09:54:22.000Z"), false, status);
  }
});

test("beehive não exige assinatura no webhook (não documentada)", () => {
  assert.equal(webhookSignatureRequired("beehive"), false);
  assert.equal(webhookSignatureRequired("velani"), true);
  assert.equal(webhookSignatureRequired("vexigate"), true);
});

test("normalizePrimaryCreate lê a resposta real da Beehive (id numérico + pix.qrcode)", () => {
  // Shape observado em produção (POST /v1/transactions, HTTP 200).
  const normalized = normalizePrimaryCreate({
    id: 134906463,
    amount: 1199,
    paidAmount: 0,
    refundedAmount: 0,
    status: "waiting_payment",
    paymentMethod: "pix",
    paidAt: null,
    ip: "189.10.20.30",
    externalRef: "",
    pix: {
      qrcode: "00020101021226820014br.gov.bcb.pix2560pix.stone.com.br/pix/v2/abc",
      expirationDate: "2026-10-20",
      end2EndId: null,
      receiptUrl: null,
    },
  });
  assert.ok(normalized);
  assert.equal(normalized?.id, "134906463");
  assert.equal(normalized?.status, "waiting_payment");
  assert.equal(normalized?.expirationDate, "2026-10-20");
  assert.match(normalized?.qrCode ?? "", /^000201/);
});

test("waiting_payment (status inicial real da Beehive) nunca conta como pago", () => {
  assert.equal(isPrimaryPaid("waiting_payment", ""), false);
  assert.equal(isPrimaryPaid("waiting_payment", "2026-10-20T10:00:00.000Z"), false);
  const info = normalizePrimaryInfo(
    { id: 1, status: "waiting_payment", amount: 1199, paidAt: null },
    "1",
    "beehive",
  );
  assert.equal(info?.paid, false);
});

test("normalizePrimaryInfo lê end2EndId de pix na Beehive", () => {
  const info = normalizePrimaryInfo(
    {
      id: 134906463,
      status: "paid",
      amount: 10440,
      paidAt: "2026-10-13T13:30:09.000Z",
      pix: { end2EndId: "E0000000020261013132942079627017" },
    },
    "134906463",
    "beehive",
  );
  assert.ok(info);
  assert.equal(info?.paid, true);
  assert.equal(info?.amount, 10440);
  assert.equal(info?.end2EndId, "E0000000020261013132942079627017");
});
