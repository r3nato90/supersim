// Gateway PIX do funil SuperSim — trocável 100% via env na Vercel. Server-side only.
//
// Configuração (env):
//   PIX_GATEWAY_API_KEY = <chave>           (obrigatória p/ ativar o gateway)
//   PIX_GATEWAY = vexigate | velani | beehive | paguex | generic  (opcional; padrão = vexigate)
//                 Valor desconhecido (typo) NÃO cai no default: o gateway fica
//                 desativado e o erro vai pro log, pra não cobrar no gateway errado.
//   PIX_GATEWAY_CREATE_URL = <url>          (opcional p/ gateways conhecidos; obrigatória no generic)
//   PIX_GATEWAY_STATUS_URL = <url com {id}> (opcional; default por gateway)
//   PIX_GATEWAY_POSTBACK_URL = <url>        (opcional; webhook por transação)
//   PIX_GATEWAY_WEBHOOK_SECRET = <segredo>  (recomendado; sem ele o webhook não tem
//                                          validação HMAC — só confirma via API)
//   PIX_GATEWAY_MIN_AMOUNT_CENTS = <centavos> (opcional; piso local de valor aceito)
//
// Gateways conhecidos (URL default preenchida automaticamente):
//   vexigate → POST https://vexigate.com/api/v1/payments/pix
//              GET  https://vexigate.com/api/v1/payments/{id}
//              amount em REAIS; auth Bearer (+ X-API-Key compat); mínimo da conta = R$ 10,00
//              (doc oficial v2.8: "depósito mínimo configurado (atualmente R$ 10,00)").
//   velani   → POST https://api.velanipagamentos.com.br/api/v1/api-gateway/v1/transactions
//              GET  https://api.velanipagamentos.com.br/api/v1/api-gateway/v1/transactions/{id}
//              amount em CENTAVOS; auth somente header `x-api-key`; mínimo R$ 1,00 (100).
//              A CRIAÇÃO exige a Secret Key (`sk_live_...`); a Public Key (`pk_live_...`)
//              é somente leitura e serve apenas para consultar/listar transações.
//              Resposta: data.pixQrCode / data.pixQrCodeImage / data.expiresAt.
//              Webhook: { event: "transaction.paid", data: {...}, signature } com
//              HMAC-SHA256 hex de JSON.stringify(payload.data) usando o whsec.
//   beehive  → POST https://api.conta.paybeehive.com.br/v1/transactions
//              GET  https://api.conta.paybeehive.com.br/v1/transactions/{id}
//              amount em CENTAVOS; auth `Basic base64(SECRET_KEY:x)` (testado
//              contra a API: Bearer responde 401; há retry no 401).
//              Exige customer (name/email/phone/document), items (tangible),
//              metadata (provider/user_email/order_id/checkout_url/shop_url) e ip.
//              Resposta real: `id` numérico, status `waiting_payment` e o
//              copia-e-cola em `pix.qrcode` (+ `pix.expirationDate`); a imagem
//              do QR é responsabilidade do cliente. Webhook: { id, type,
//              objectId, url, data } com type "transaction" e data.amount em
//              centavos; NÃO documenta assinatura HMAC → confirmação via API.
//   generic  → o cliente informa a URL; enviamos o pedido + aliases
//              (amount_cents/amount_reais, webhook_url/callback_url) e aceitamos
//              várias chaves de resposta (id/txnId/..., qrcode/copy_paste/...).
//   hub      → Gatehub (hub de gateways): uma API só e a gateway real (Beehive,
//              Velani, Pingu, Pague-X, FreePay) é escolhida no painel, trocável
//              sem deploy. Credenciais HUB_URL / HUB_API_KEY (hub_live_...),
//              funil opcional em HUB_SLUG e webhook em HUB_WEBHOOK_SECRET
//              (whs_...). amount em CENTAVOS; id de cobrança `gateway_id`;
//              `pix.copyPaste` sempre presente e `pix.qrCode` pode vir vazio
//              (gerar o QR no navegador). Webhook: { event: "charge.updated",
//              charge: { id, status, amount, method, reference } } com
//              `x-hub-signature` = "sha256=" + HMAC-SHA256 hex do corpo bruto.
//              Idempotência por `Idempotency-Key`/`reference` (24 h).
//              Ver docs/hub.md.

const REQUEST_TIMEOUT_MS = 20_000;

export type GatewayKind = "vexigate" | "velani" | "beehive" | "paguex" | "hub" | "generic";

const KNOWN_KINDS = new Set<string>(["vexigate", "velani", "beehive", "paguex", "hub", "generic"]);

export type PrimaryEnv = {
  configured: boolean;
  kind: GatewayKind;
  createUrl: string;
  statusUrl: string;
  apiKey: string;
  postbackUrl: string;
  webhookSecret: string;
  minAmountCents: number;
  /** Funil do hub (`HUB_SLUG`): define qual gateway cobra este projeto. */
  funnel: string;
};

// Domínio sem www conforme orientação do suporte para chamadas da Vercel.
const VEXIGATE_CREATE_URL = "https://vexigate.com/api/v1/payments/pix";
const VEXIGATE_STATUS_URL = "https://vexigate.com/api/v1/payments/{id}";
const VEXIGATE_MIN_AMOUNT_CENTS = 1000; // R$ 10,00 (doc oficial v2.8 + teste real na conta)

// Velani Pagamentos (API v1.0 — docs/api). amount em CENTAVOS.
// Mínimo: a doc diz 100 (R$ 1,00), mas o valor é configurável por conta — na
// conta deste funil o gateway recusa abaixo de 500 com
// `{"message":"Valor mínimo: R$ 5,00 (500 centavos)"}`. Usamos 500 como piso
// local (fail-fast, sem round-trip); `PIX_GATEWAY_MIN_AMOUNT_CENTS` sobrescreve.
const VELANI_CREATE_URL = "https://api.velanipagamentos.com.br/api/v1/api-gateway/v1/transactions";
const VELANI_STATUS_URL =
  "https://api.velanipagamentos.com.br/api/v1/api-gateway/v1/transactions/{id}";
const VELANI_MIN_AMOUNT_CENTS = 500;

// Beehive Pay (docs.beehivehub.io) — API v1. amount em CENTAVOS.
// Sem mínimo documentado; o piso local fica 0 e a rota já recusa < R$5,00.
const BEEHIVE_CREATE_URL = "https://api.conta.paybeehive.com.br/v1/transactions";
const BEEHIVE_STATUS_URL = "https://api.conta.paybeehive.com.br/v1/transactions/{id}";
const BEEHIVE_MIN_AMOUNT_CENTS = 0;

// Pague-X: centavos, Bearer secret key, HMAC-SHA256 do corpo bruto.
const PAGUEX_CREATE_URL = "https://api.pague-x.com.br/v1/charges";
const PAGUEX_STATUS_URL = "https://api.pague-x.com.br/v1/charges/{id}";

// Gatehub ("hub de gateways"): única URL para todas as gateways. A gateway
// real é escolhida no painel (ou por funil) e trocada sem mexer no código.
// `HUB_URL` sobrescreve o host; a doc do hub usa este domínio como exemplo.
const HUB_DEFAULT_URL = "https://hub-de-gateways.vercel.app";
// O mínimo é o da gateway ativa no painel (R$ 1,00 a R$ 5,00 dependendo dela);
// a rota já recusa valor < R$ 5,00, então o piso local fica 0.
const HUB_MIN_AMOUNT_CENTS = 0;

function defaultCreateUrl(kind: GatewayKind): string {
  if (kind === "vexigate") return VEXIGATE_CREATE_URL;
  if (kind === "velani") return VELANI_CREATE_URL;
  if (kind === "beehive") return BEEHIVE_CREATE_URL;
  if (kind === "paguex") return PAGUEX_CREATE_URL;
  // O hub depende de HUB_URL: a URL é montada em resolvePrimaryEnv.
  return "";
}

function defaultStatusUrl(kind: GatewayKind): string {
  if (kind === "vexigate") return VEXIGATE_STATUS_URL;
  if (kind === "velani") return VELANI_STATUS_URL;
  if (kind === "beehive") return BEEHIVE_STATUS_URL;
  if (kind === "paguex") return PAGUEX_STATUS_URL;
  return "";
}

function defaultMinAmountCents(kind: GatewayKind): number {
  if (kind === "vexigate") return VEXIGATE_MIN_AMOUNT_CENTS;
  if (kind === "velani") return VELANI_MIN_AMOUNT_CENTS;
  if (kind === "beehive") return BEEHIVE_MIN_AMOUNT_CENTS;
  if (kind === "hub") return HUB_MIN_AMOUNT_CENTS;
  return 0;
}

function urlHost(url: string): string {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return "";
  }
}

/** Avisa quando o override de URL aponta pra um gateway diferente do escolhido.
 *  `PIX_GATEWAY_CREATE_URL` sobrepõe a URL do adapter, então um override
 *  esquecido faz o payload de um gateway ser enviado no endereço de outro. */
function warnOnHostMismatch(kind: GatewayKind, createUrl: string): void {
  if (kind === "generic" || !createUrl) return;
  const expected = defaultCreateUrl(kind);
  const got = urlHost(createUrl);
  const want = urlHost(expected);
  if (got && want && got !== want) {
    console.error(
      "[pay-gateway] PIX_GATEWAY_CREATE_URL aponta para outro gateway que o escolhido em PIX_GATEWAY:",
      { kind, host: got, esperado: urlHost(expected) },
    );
  }
}

function readEnv(env?: Record<string, string | undefined>): Record<string, string | undefined> {
  return (
    env ??
    (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ??
    {}
  );
}

function parseMinAmountCents(raw: string, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function isHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}

type HubEnv = { url: string; apiKey: string; slug: string; webhookSecret: string };

/** Credenciais do hub de gateways (`HUB_*`). Somente servidor. */
function resolveHubEnv(e: Record<string, string | undefined>): HubEnv {
  return {
    url: ((e["HUB_URL"] ?? "").trim() || HUB_DEFAULT_URL).replace(/\/+$/, ""),
    apiKey: (e["HUB_API_KEY"] ?? "").trim(),
    slug: (e["HUB_SLUG"] ?? "").trim().toLowerCase(),
    webhookSecret: (e["HUB_WEBHOOK_SECRET"] ?? "").trim(),
  };
}

export function resolvePrimaryEnv(env?: Record<string, string | undefined>): PrimaryEnv {
  const e = readEnv(env);
  const rawKind = (e["PIX_GATEWAY"] ?? "").trim().toLowerCase();
  const hubKey = (e["HUB_API_KEY"] ?? "").trim();

  // Valor desconhecido NÃO cai no default em silêncio: rotear cobrança pro
  // gateway errado é pior que recusar. Vazio = default; typo =
  // não-configurado + log, pra aparecer no log da hospedagem.
  if (rawKind && !KNOWN_KINDS.has(rawKind)) {
    console.error(
      "[pay-gateway] PIX_GATEWAY com valor desconhecido; gateway desativado para não cobrar no gateway errado:",
      JSON.stringify(rawKind),
      "- valores aceitos:",
      [...KNOWN_KINDS].join(", "),
    );
    return {
      configured: false,
      kind: "vexigate",
      createUrl: "",
      statusUrl: "",
      apiKey: (e["PIX_GATEWAY_API_KEY"] ?? "").trim(),
      postbackUrl: (e["PIX_GATEWAY_POSTBACK_URL"] ?? "").trim(),
      webhookSecret: (e["PIX_GATEWAY_WEBHOOK_SECRET"] ?? "").trim(),
      minAmountCents: 0,
      funnel: "",
    };
  }

  // Default: sem `PIX_GATEWAY` explícito, a presença de `HUB_API_KEY` ativa o
  // hub (a gateway real é escolhida no painel). Sem ela, Vexigate, como antes.
  // `PIX_GATEWAY=velani|beehive|...` continua mandando sobre o default — a
  // escolha explícita vence, então um rollback é só preencher o PIX_GATEWAY.
  const kind: GatewayKind = KNOWN_KINDS.has(rawKind)
    ? (rawKind as GatewayKind)
    : hubKey
      ? "hub"
      : "vexigate";
  const isHub = kind === "hub";
  const hub = isHub ? resolveHubEnv(e) : null;

  // O hub tem uma URL só (HUB_URL + os caminhos da API v1); as outras gateways
  // usam a URL fixa do adapter, sobrescrita por PIX_GATEWAY_CREATE_URL.
  const createUrl = isHub
    ? (e["PIX_GATEWAY_CREATE_URL"] ?? "").trim() || `${hub?.url}/api/v1/charges`
    : (e["PIX_GATEWAY_CREATE_URL"] ?? "").trim() || defaultCreateUrl(kind);
  const statusUrl = isHub
    ? (e["PIX_GATEWAY_STATUS_URL"] ?? "").trim() || `${hub?.url}/api/v1/charges/{id}`
    : (e["PIX_GATEWAY_STATUS_URL"] ?? "").trim() || defaultStatusUrl(kind);
  warnOnHostMismatch(kind, createUrl);
  if (isHub && hub && urlHost(createUrl) && urlHost(createUrl) !== urlHost(hub.url)) {
    console.error("[pay-gateway] PIX_GATEWAY_CREATE_URL não aponta para o hub de HUB_URL:", {
      host: urlHost(createUrl),
      hub: urlHost(hub.url),
    });
  }
  // A chave do hub nunca sai de HUB_API_KEY: reaproveitar PIX_GATEWAY_API_KEY
  // (chave de outra gateway) mandaria a credencial errada e tomaria 401.
  const apiKey = isHub ? (hub?.apiKey ?? "") : (e["PIX_GATEWAY_API_KEY"] ?? "").trim();
  // O hub não aceita callback por cobrança: o webhook é o cadastrado no painel.
  const postbackUrl = isHub ? "" : (e["PIX_GATEWAY_POSTBACK_URL"] ?? "").trim();
  const webhookSecret = isHub
    ? (hub?.webhookSecret ?? "") || (e["PIX_GATEWAY_WEBHOOK_SECRET"] ?? "").trim()
    : (e["PIX_GATEWAY_WEBHOOK_SECRET"] ?? "").trim();
  // Não enviar a Secret Key da Velani a um override esquecido de outro gateway.
  const velaniUrlSafe = (value: string): boolean => {
    try {
      const url = new URL(value);
      return (
        url.protocol === "https:" &&
        url.host === urlHost(VELANI_CREATE_URL) &&
        !url.username &&
        !url.password
      );
    } catch {
      return false;
    }
  };
  const endpointsSafe =
    kind === "velani"
      ? velaniUrlSafe(createUrl) && velaniUrlSafe(statusUrl)
      : // Chave `hub_live_` só trafega em HTTPS.
        isHub
        ? isHttpsUrl(createUrl) && isHttpsUrl(statusUrl)
        : true;
  const isUrl = createUrl.startsWith("http://") || createUrl.startsWith("https://");
  return {
    configured: isUrl && apiKey.length > 0 && endpointsSafe,
    kind,
    createUrl,
    statusUrl,
    apiKey,
    postbackUrl,
    webhookSecret,
    minAmountCents: parseMinAmountCents(
      (e["PIX_GATEWAY_MIN_AMOUNT_CENTS"] ?? "").trim(),
      defaultMinAmountCents(kind),
    ),
    funnel: hub?.slug ?? "",
  };
}

/** Valor mínimo aceito pelo gateway (evita enviar cobrança que tomaria 422). */
export function primarySupportsAmount(env: PrimaryEnv, amountCents: number): boolean {
  return amountCents >= env.minAmountCents;
}

// ─── helpers ───

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function unwrap(body: Record<string, unknown>): Record<string, unknown> {
  return asRecord(body["data"]) ?? body;
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function firstStr(obj: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) {
    const v = str(obj[k]);
    if (v) return v;
  }
  return "";
}

/** Ids numéricos: a Beehive devolve `{ id: 282 }`, a Velani `{ id: "uuid" }`.
 *  `str()` descarta números, então os ids usam este helper. */
function firstId(obj: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) {
    const raw = obj[k];
    if (typeof raw === "string" && raw.trim()) return raw.trim();
    if (typeof raw === "number" && Number.isFinite(raw)) return String(raw);
  }
  return "";
}

/** Base64 (padrão Basic Auth) sem depender de Buffer: roda em Node e em
 *  runtimes edge/Workers, onde só existe `btoa`. */
function base64(input: string): string {
  const g = globalThis as {
    btoa?: (value: string) => string;
    Buffer?: { from(value: string, encoding: string): { toString(encoding: string): string } };
  };
  if (typeof g.btoa === "function") return g.btoa(input);
  if (g.Buffer) return g.Buffer.from(input, "utf8").toString("base64");
  return "";
}

/** Beehive autentica com Basic Auth: `SECRET_KEY:x` em base64. */
function beehiveBasicToken(apiKey: string): string {
  return base64(`${apiKey}:x`);
}

type AuthScheme = "bearer" | "basic";

function authHeaders(
  apiKey: string,
  kind: GatewayKind,
  scheme: AuthScheme = "bearer",
): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json",
    "User-Agent": "funil-supersim/1.0",
  };
  if (apiKey) {
    // Velani usa SOMENTE `x-api-key` (doc API v1.0). Os demais aceitam Bearer
    // (+ X-API-Key como compatibilidade).
    if (kind === "velani") {
      headers["x-api-key"] = apiKey;
    } else if (kind === "beehive") {
      // A doc da Beehive é contraditória: a página "Autenticação" e os SDKs
      // usam `Basic base64(SECRET_KEY:x)`, enquanto o llms.txt (gerado em
      // 2026-05-07) manda `Bearer base64(SECRET_KEY:x)`. Testado contra a API
      // real: Bearer responde 401 e Basic autentica. Ver fetchGateway.
      const token = beehiveBasicToken(apiKey);
      headers["Authorization"] = scheme === "basic" ? `Basic ${token}` : `Bearer ${token}`;
    } else {
      headers["Authorization"] = `Bearer ${apiKey}`;
      // O hub (e a Pague-X) autenticam só por Bearer.
      if (kind !== "paguex" && kind !== "hub") headers["X-API-Key"] = apiKey;
    }
  }
  return headers;
}

async function fetchGateway(
  url: string,
  init: RequestInit,
  apiKey: string,
  kind: GatewayKind,
): Promise<Response> {
  const attempt = (scheme: AuthScheme) =>
    fetch(url, {
      ...init,
      headers: {
        ...(init.headers as Record<string, string>),
        ...authHeaders(apiKey, kind, scheme),
      },
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  // Verificado contra a API real: a Beehive responde 401 ao Bearer e aceita
  // Basic. O llms.txt dela documenta Bearer, então mantemos o retry no 401 —
  // 401 não cria cobrança, logo repetir não duplica nada.
  const first: AuthScheme = kind === "beehive" ? "basic" : "bearer";
  const response = await attempt(first);
  if (kind !== "beehive" || response.status !== 401) return response;
  console.warn(`[pay-gateway] Beehive recusou ${first}; repetindo com a outra forma de auth`);
  return attempt(first === "basic" ? "bearer" : "basic");
}

async function postJson(
  url: string,
  apiKey: string,
  body: unknown,
  kind: GatewayKind,
  headers: Record<string, string> = {},
): Promise<{ httpStatus: number; data: Record<string, unknown> }> {
  const response = await fetchGateway(
    url,
    { method: "POST", body: JSON.stringify(body), headers },
    apiKey,
    kind,
  );
  let data: Record<string, unknown> = {};
  try {
    const parsed = (await response.json()) as unknown;
    if (parsed && typeof parsed === "object") data = parsed as Record<string, unknown>;
  } catch {
    // Não expor HTML do proxy/WAF ao navegador nem registrar dados do pagador.
    if (!response.ok) {
      data = {
        success: false,
        message:
          response.status === 403
            ? "A chamada ao gateway foi bloqueada (HTTP 403, resposta não JSON). Verifique os logs do servidor e o acesso da Vercel ao gateway."
            : "O gateway retornou uma resposta inválida. Tente novamente em instantes.",
      };
    }
  }
  if (!response.ok) {
    const endpoint = new URL(url);
    console.error("[pay-gateway] criação recusada", {
      endpoint: `${endpoint.origin}${endpoint.pathname}`,
      httpStatus: response.status,
      contentType: response.headers.get("content-type"),
      server: response.headers.get("server"),
      cfRay: response.headers.get("cf-ray"),
      cfMitigated: response.headers.get("cf-mitigated"),
      message: primaryErrorMessage(data, "Resposta sem mensagem de erro"),
    });
  }
  return { httpStatus: response.status, data };
}

async function getJson(
  url: string,
  apiKey: string,
  kind: GatewayKind,
): Promise<{ httpStatus: number; data: Record<string, unknown> } | null> {
  try {
    const response = await fetchGateway(url, { method: "GET" }, apiKey, kind);
    let data: Record<string, unknown> = {};
    try {
      const parsed = (await response.json()) as unknown;
      if (parsed && typeof parsed === "object") data = parsed as Record<string, unknown>;
    } catch {
      return null;
    }
    return { httpStatus: response.status, data };
  } catch {
    return null;
  }
}

// ─── payload ───

const UTM_KEYS = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "src",
  "sck",
  "gclid",
  "fbclid",
  "ttclid",
];

/** Payload genérico: pedido + aliases. O endpoint do cliente traduz. */
function buildGenericPayload(
  fp: Record<string, unknown>,
  env: PrimaryEnv,
): Record<string, unknown> {
  const payload: Record<string, unknown> = { ...fp };
  const amount = fp["amount"];
  if (typeof amount === "number" && Number.isFinite(amount)) {
    payload["amount_cents"] = amount;
    payload["amount_reais"] = amount / 100;
  }
  if (env.postbackUrl) {
    payload["postback_url"] = env.postbackUrl;
    payload["webhook_url"] = env.postbackUrl;
    payload["callback_url"] = env.postbackUrl;
  }
  return payload;
}

/** Payload Vexigate (doc oficial v2.8): amount em reais, customer.document string, UTMs soltas. */
function buildVexigatePayload(
  fp: Record<string, unknown>,
  env: PrimaryEnv,
): Record<string, unknown> {
  const amountCents = typeof fp["amount"] === "number" ? fp["amount"] : 0;
  const customer = asRecord(fp["customer"]) ?? {};
  const doc = asRecord(customer["document"]) ?? {};
  const items = Array.isArray(fp["items"]) ? fp["items"] : [];
  const firstItem = asRecord(items[0]) ?? {};
  const metadata = asRecord(fp["metadata"]) ?? {};

  const body: Record<string, unknown> = {
    amount: Math.round(amountCents) / 100,
    method: "pix",
    customer: {
      name: customer["name"],
      document: doc["number"],
      email: customer["email"],
      phone: customer["phone"],
    },
    external_reference: metadata["order_id"],
  };
  const description = str(firstItem["title"]);
  if (description) body["description"] = description;
  if (env.postbackUrl) body["callback_url"] = env.postbackUrl;

  const tracking: Record<string, string> = {};
  for (const key of UTM_KEYS) {
    const value = str(metadata[key]);
    if (value) {
      body[key] = value;
      tracking[key] = value;
    }
  }
  if (Object.keys(tracking).length) body["tracking_json"] = tracking;
  return body;
}

// UTMs que a Velani aceita no objeto `tracking` (doc API v1.0). Fora dessa lista
// (gclid/fbclid) não há campo — o funil continua mandando ao Meta CAPI por conta própria.
const VELANI_TRACKING_KEYS = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "src",
  "sck",
];

/** Payload Velani (doc API v1.0): amount em CENTAVOS, camelCase, customer.document objeto. */
function buildVelaniPayload(fp: Record<string, unknown>, env: PrimaryEnv): Record<string, unknown> {
  const amountCents = typeof fp["amount"] === "number" ? Math.round(fp["amount"]) : 0;
  const customer = asRecord(fp["customer"]) ?? {};
  const doc = asRecord(customer["document"]) ?? {};
  const items = Array.isArray(fp["items"]) ? fp["items"] : [];
  const metadata = asRecord(fp["metadata"]) ?? {};

  const customerBody: Record<string, unknown> = {};
  const name = str(customer["name"]);
  if (name) customerBody["name"] = name;
  const email = str(customer["email"]);
  if (email) customerBody["email"] = email;
  const phone = beehivePhone(str(customer["phone"]));
  if (phone) customerBody["phone"] = phone.slice(3);
  const docNumber = str(doc["number"]).replace(/\D/g, "");
  if (docNumber) {
    customerBody["document"] = { type: str(doc["type"]) || "cpf", number: docNumber };
  }

  const body: Record<string, unknown> = {
    paymentMethod: "pix",
    amount: amountCents,
    customer: customerBody,
  };

  const velaniItems = items
    .map((item) => {
      const it = asRecord(item) ?? {};
      const unit =
        typeof it["unit_price"] === "number" ? Math.round(it["unit_price"]) : amountCents;
      const quantity =
        typeof it["quantity"] === "number" && it["quantity"] > 0 ? it["quantity"] : 1;
      return { title: str(it["title"]) || "Pagamento", unitPrice: unit, quantity };
    })
    .filter((item) => item.unitPrice > 0);
  if (velaniItems.length) body["items"] = velaniItems;

  const externalId = str(metadata["order_id"]);
  if (externalId) body["externalId"] = externalId;
  const description = str(asRecord(items[0])?.["title"]);
  if (description) body["description"] = description;
  if (env.postbackUrl) body["postbackUrl"] = env.postbackUrl;

  const tracking: Record<string, string> = {};
  for (const key of VELANI_TRACKING_KEYS) {
    const value = str(metadata[key]);
    if (value) tracking[key] = value;
  }
  if (Object.keys(tracking).length) body["tracking"] = tracking;
  return body;
}

/** Identificador do canal enviado no metadata.provider da Beehive. */
const BEEHIVE_PROVIDER = "funil-supersim";

/** DDDs realmente atribuídos no Brasil (ANATEL). Número com DDD inexistente
 *  (20, 26, 30, 39...) também volta 422 na Beehive — melhor omitir. */
const DDDS_VALIDOS = new Set([
  "11",
  "12",
  "13",
  "14",
  "15",
  "16",
  "17",
  "18",
  "19",
  "21",
  "22",
  "24",
  "27",
  "28",
  "31",
  "32",
  "33",
  "34",
  "35",
  "37",
  "38",
  "41",
  "42",
  "43",
  "44",
  "45",
  "46",
  "47",
  "48",
  "49",
  "51",
  "53",
  "54",
  "55",
  "61",
  "62",
  "63",
  "64",
  "65",
  "66",
  "67",
  "68",
  "69",
  "71",
  "73",
  "74",
  "75",
  "77",
  "79",
  "81",
  "82",
  "83",
  "84",
  "86",
  "87",
  "88",
  "89",
  "91",
  "92",
  "93",
  "94",
  "95",
  "96",
  "97",
  "98",
  "99",
]);

/** Telefone no formato que a Beehive aceita.
 *  Verificado contra a API: 13 dígitos com país e SEM o `+`
 *  (o formato que o funil manda, ex.: `5511999999999`) → HTTP 422
 *  `customer.phone is invalid`; em E.164 (`+5511999999999`) passa na validação.
 *  Devolve "" quando o número não é um telefone brasileiro plausível — nesse
 *  caso o campo é omitido (a Beehive aceita transação sem `phone`, mas não com
 *  `phone` inválido).
 *
 *  Bug real de produção (20/10/2026): o funil recebeu `55588888888` (DDD 55 +
 *  `888888888`, que não existe — celular tem 9 dígitos começando em 9) e a
 *  validação antiga aceitava, mandando `+5555588888888` → 422 e venda perdida.
 *  Agora celular (9 dígitos) tem de começar em 9 e fixo (8 dígitos) em 2–5. */
function beehivePhone(raw: string): string {
  let digits = raw.replace(/\D/g, "").replace(/^0+/, "");
  if (!digits) return "";
  // Código do país explícito (12/13 dígitos começando em 55) → remove.
  // Com 11 dígitos NÃO remove: `55999999999` é DDD 55 + celular.
  if (digits.length > 11 && digits.startsWith("55")) digits = digits.slice(2);
  const ddd = digits.slice(0, 2);
  const number = digits.slice(2);
  const celular = digits.length === 11 && /^9\d{8}$/.test(number);
  const fixo = digits.length === 10 && /^[2-5]\d{7}$/.test(number);
  if (!celular && !fixo) return "";
  if (!DDDS_VALIDOS.has(ddd)) return "";
  return `+55${digits}`;
}

/** Payload Beehive (docs.beehivehub.io): amount em CENTAVOS, camelCase,
 *  `items[].tangible` obrigatório e metadata fixo
 *  (provider/user_email/order_id/checkout_url/shop_url). */
function buildBeehivePayload(
  fp: Record<string, unknown>,
  env: PrimaryEnv,
): Record<string, unknown> {
  const amountCents = typeof fp["amount"] === "number" ? Math.round(fp["amount"]) : 0;
  const customer = asRecord(fp["customer"]) ?? {};
  const doc = asRecord(customer["document"]) ?? {};
  const items = Array.isArray(fp["items"]) ? fp["items"] : [];
  const metadata = asRecord(fp["metadata"]) ?? {};

  const customerBody: Record<string, unknown> = {
    name: str(customer["name"]),
    email: str(customer["email"]),
    document: { type: str(doc["type"]) || "cpf", number: str(doc["number"]) },
  };
  const phone = beehivePhone(str(customer["phone"]));
  if (phone) customerBody["phone"] = phone;

  const beehiveItems = items
    .map((item) => {
      const it = asRecord(item) ?? {};
      const unitPrice =
        typeof it["unit_price"] === "number" ? Math.round(it["unit_price"]) : amountCents;
      const quantity =
        typeof it["quantity"] === "number" && it["quantity"] > 0 ? it["quantity"] : 1;
      const entry: Record<string, unknown> = {
        title: str(it["title"]) || "Pedido",
        unitPrice,
        quantity,
        tangible: it["tangible"] === true,
      };
      const externalRef = str(it["external_ref"]);
      if (externalRef) entry["externalRef"] = externalRef;
      return entry;
    })
    .filter((item) => (item["unitPrice"] as number) > 0);

  const body: Record<string, unknown> = {
    amount: amountCents,
    paymentMethod: "pix",
    customer: customerBody,
    items: beehiveItems,
    // Obrigatório: sem metadata a requisição é invalidada pela Beehive.
    metadata: {
      provider: BEEHIVE_PROVIDER,
      user_email: str(customer["email"]),
      order_id: str(metadata["order_id"]),
      checkout_url: str(metadata["checkout_url"]),
      shop_url: str(metadata["shop_url"]),
    },
  };

  // `ip` (IP público do comprador) é obrigatório desde 06/10/2026.
  const ip = str(fp["ip"]);
  if (ip) body["ip"] = ip;

  const externalRef = str(metadata["order_id"]);
  if (externalRef) body["externalRef"] = externalRef;
  if (env.postbackUrl) body["postbackUrl"] = env.postbackUrl;

  // O funil trabalha em dias; a Beehive recebe segundos (campo opcional).
  const pix = asRecord(fp["pix"]) ?? {};
  const expiresInDays = typeof pix["expires_in_days"] === "number" ? pix["expires_in_days"] : 0;
  if (expiresInDays > 0) body["pix"] = { expiresInSeconds: Math.round(expiresInDays * 86400) };
  return body;
}

/** Pague-X usa documento como string e telefone nacional (DDD + número).
 * reference é conciliação, NÃO uma chave de idempotência. Nunca repetir POST automaticamente. */
function buildPaguexPayload(fp: Record<string, unknown>, env: PrimaryEnv): Record<string, unknown> {
  const customer = asRecord(fp["customer"]) ?? {};
  const doc = asRecord(customer["document"]) ?? {};
  const metadata = asRecord(fp["metadata"]) ?? {};
  const items = Array.isArray(fp["items"]) ? fp["items"] : [];
  const customerBody: Record<string, unknown> = {
    name: str(customer["name"]),
    email: str(customer["email"]),
    document: str(doc["number"]).replace(/\D/g, ""),
  };
  const phone = beehivePhone(str(customer["phone"]));
  if (phone) customerBody["phone"] = phone.slice(3);
  const body: Record<string, unknown> = {
    amount: typeof fp["amount"] === "number" ? Math.round(fp["amount"]) : 0,
    currency: "BRL",
    paymentMethod: "pix",
    customer: customerBody,
  };
  const reference = str(metadata["order_id"]);
  if (reference) body["reference"] = reference;
  const description = str(asRecord(items[0])?.["title"]);
  if (description) body["description"] = description;
  if (env.postbackUrl) body["postbackUrl"] = env.postbackUrl;
  return body;
}

/** Telefone no formato do contrato do hub ("telefone com DDD"): DDD + número,
 *  sem DDI. Só descarta se nem parece um número brasileiro de 10/11 dígitos —
 *  a validação fina é do navegador (phone-br.js) e da gateway. Diferente do
 *  `beehivePhone` (usado na Beehive direta), aqui não há lista de DDDs válidos:
 *  derrubar o campo quebraria Pingu/FreePay, que exigem telefone. */
function hubPhone(raw: string): string {
  let digits = raw.replace(/\D/g, "").replace(/^0+/, "");
  // 12/13 dígitos começando em 55 = com país. Com 11 dígitos NÃO remove:
  // `55999999999` é DDD 55 + celular.
  if (digits.length > 11 && digits.startsWith("55")) digits = digits.slice(2);
  return digits.length === 10 || digits.length === 11 ? digits : "";
}

/** Payload do hub de gateways (docs/hub.md): amount em CENTAVOS, `method` fixo
 *  em pix, `customer.document` como string só de números e `reference` = id do
 *  pedido (o hub também usa a reference como chave de idempotência por 24 h).
 *  `items` e `tracking` não vão para a gateway: servem ao relatório por produto
 *  e ao rastreamento de UTMs do painel do hub. */
function buildHubPayload(fp: Record<string, unknown>, env: PrimaryEnv): Record<string, unknown> {
  const amountCents = typeof fp["amount"] === "number" ? Math.round(fp["amount"]) : 0;
  const customer = asRecord(fp["customer"]) ?? {};
  const doc = asRecord(customer["document"]) ?? {};
  const items = Array.isArray(fp["items"]) ? fp["items"] : [];
  const metadata = asRecord(fp["metadata"]) ?? {};

  const customerBody: Record<string, unknown> = {
    name: str(customer["name"]),
    email: str(customer["email"]),
  };
  const documentNumber = str(doc["number"]).replace(/\D/g, "");
  if (documentNumber) customerBody["document"] = documentNumber;
  // Telefone no formato do CONTRATO DO HUB (`11999999999`: DDD + número, sem
  // código do país) — cada gateway de trás quer um formato diferente e é o hub
  // que normaliza.
  const phone = hubPhone(str(customer["phone"]));
  if (phone) customerBody["phone"] = phone;

  const body: Record<string, unknown> = {
    amount: amountCents,
    method: "pix",
    customer: customerBody,
  };
  if (env.funnel) body["funnel"] = env.funnel;

  const reference = str(metadata["order_id"]);
  if (reference) body["reference"] = reference;
  const description = str(asRecord(items[0])?.["title"]);
  if (description) body["description"] = description;

  // `ip` é o do COMPRADOR (a Beehive exige); sem ele o hub veria o IP do servidor.
  const ip = str(fp["ip"]);
  if (ip) body["ip"] = ip;

  const shopUrl = str(metadata["shop_url"]);
  if (shopUrl) body["shopUrl"] = shopUrl;
  const checkoutUrl = str(metadata["checkout_url"]);
  if (checkoutUrl) body["checkoutUrl"] = checkoutUrl;

  const hubItems = items
    .map((item) => {
      const it = asRecord(item) ?? {};
      const unitPrice =
        typeof it["unit_price"] === "number" ? Math.round(it["unit_price"]) : amountCents;
      const quantity =
        typeof it["quantity"] === "number" && it["quantity"] > 0 ? it["quantity"] : 1;
      const entry: Record<string, unknown> = {
        name: str(it["title"]) || "Pedido",
        price: unitPrice,
        quantity,
      };
      const externalRef = str(it["external_ref"]);
      if (externalRef) entry["id"] = externalRef;
      return entry;
    })
    .filter((item) => (item["price"] as number) > 0);
  if (hubItems.length) body["items"] = hubItems;

  // Origem da venda para o painel de rastreamento (substitui a UTMify lá dentro).
  const attribution: Record<string, string> = {};
  for (const key of UTM_KEYS) {
    const value = str(metadata[key]);
    if (value) attribution[key] = value;
  }
  if (Object.keys(attribution).length) body["tracking"] = { attribution };
  return body;
}

export function buildPrimaryPayload(
  orderPayload: Record<string, unknown>,
  env: PrimaryEnv,
): Record<string, unknown> {
  if (env.kind === "vexigate") return buildVexigatePayload(orderPayload, env);
  if (env.kind === "velani") return buildVelaniPayload(orderPayload, env);
  if (env.kind === "beehive") return buildBeehivePayload(orderPayload, env);
  if (env.kind === "paguex") return buildPaguexPayload(orderPayload, env);
  if (env.kind === "hub") return buildHubPayload(orderPayload, env);
  return buildGenericPayload(orderPayload, env);
}

/** Telefone para log: nunca o número inteiro (PII), só o tamanho e os 4
 *  últimos dígitos — o suficiente para casar com o relato do cliente. */
export function maskPhone(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (!digits) return "(vazio)";
  return `${digits.length} dígitos, final ${digits.slice(-4)}`;
}

export async function primaryCreate(
  payload: Record<string, unknown>,
  env: PrimaryEnv,
): Promise<{ httpStatus: number; data: Record<string, unknown> }> {
  if (!env.configured) throw new Error("Gateway não configurado para criação");
  if (env.kind === "velani" && !env.apiKey.startsWith("sk_live_")) {
    throw new Error("A criação Velani exige uma Secret Key server-side (sk_live_...)");
  }
  const body = buildPrimaryPayload(payload, env);
  const headers: Record<string, string> = {};
  if (env.kind === "velani" && str(body["externalId"])) {
    // A referência server-side já vincula documento/produto/valor/conta.
    // Nome, contato, título e callback não podem criar outra chave num retry.
    const identity = JSON.stringify([
      "velani-order-v2",
      body["externalId"],
      body["amount"],
      body["paymentMethod"],
    ]);
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(identity));
    headers["x-idempotency-key"] = [...new Uint8Array(digest)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }
  if (env.kind === "hub") {
    // Idempotência do hub: a mesma chave por até 24 h devolve a MESMA cobrança
    // (header `x-idempotent-replay: 1`), em vez de criar outra. Sem o header o
    // hub usaria a `reference`, que já é derivada do pedido — mandar explícito
    // mantém o comportamento documentado mesmo se a reference mudar de formato.
    const reference = str(body["reference"]);
    if (reference) headers["Idempotency-Key"] = reference;
  }
  const result = await postJson(env.createUrl, env.apiKey, body, env.kind, headers);
  const customer = asRecord(body["customer"]);
  const phoneSent = customer ? str(customer["phone"]) : "";
  // Rede de segurança do `customer.phone`. Já vimos o gateway/adquirente recusar
  // o telefone de dois jeitos: 422 `customer.phone is invalid` (Beehive) e 424
  // "Informe um número de telefone válido" (adquirente, no log de 20/10 13:14).
  // Como a transação SEM `phone` é aceita, um campo opcional nunca deve derrubar
  // a venda: repete uma vez sem ele. Nesses dois status nada foi criado, então a
  // repetição não duplica cobrança.
  if (
    env.kind === "beehive" &&
    phoneSent &&
    (result.httpStatus === 422 || result.httpStatus === 424)
  ) {
    const message = primaryErrorMessage(result.data, "");
    if (/phone|telefone/i.test(message)) {
      console.warn(
        "[pay-gateway] gateway recusou o telefone; repetindo sem phone:",
        maskPhone(phoneSent),
        "| status",
        result.httpStatus,
      );
      delete customer?.["phone"];
      return postJson(env.createUrl, env.apiKey, body, env.kind);
    }
  }
  // 424 da Beehive = a adquirente não devolveu o QR. Já foi transitório em teste
  // (o mesmo payload voltou 201 minutos depois) e, quando é recusa do pagador
  // (CPF de teste, ex. 12345678909), a segunda tentativa recusa igual — por isso
  // só uma repetição, e só nesse status. O corpo é o mesmo (`metadata.order_id`
  // idêntico), então a UTMify não duplica nada; no pior caso fica uma cobrança
  // sem QR no painel do gateway. 5xx NÃO é repetido: aí a cobrança pode ter
  // sido criada e a repetição geraria dois PIX para o mesmo pedido.
  if (env.kind !== "beehive" || result.httpStatus !== 424) return result;
  console.warn("[pay-gateway] Beehive devolveu 424 (sem QR); repetindo a criação uma vez");
  return postJson(env.createUrl, env.apiKey, body, env.kind);
}

// ─── resposta do create ───

export function isPrimarySuccess(httpStatus: number, body: Record<string, unknown>): boolean {
  if (httpStatus < 200 || httpStatus >= 300) return false;
  const txn = unwrap(body);
  return body["success"] !== false && txn["success"] !== false;
}

export function primaryErrorMessage(body: Record<string, unknown>, fallback: string): string {
  // Validação real da Velani (observado): { message, error: "Bad Request", statusCode }
  // — e não o { success: false, error: { message } } que a doc mostra. Cobre os dois:
  // primeiro o objeto aninhado em `error`, depois as chaves soltas abaixo.
  const errorObject = asRecord(body["error"]);
  const errorObjectMessage = str(errorObject?.["message"]);
  if (errorObjectMessage) return errorObjectMessage;
  const txn = unwrap(body);
  const errors = txn["error_messages"] ?? txn["errors"];
  // Array de objetos/strings: [{ message }] ou ["msg"]
  if (Array.isArray(errors)) {
    for (const item of errors) {
      const message = str(item) || str(asRecord(item)?.["message"]);
      if (message) return message;
    }
  }
  // Objeto por campo: { amount: ["msg"], ... }
  const errorMap = asRecord(errors);
  if (errorMap) {
    for (const value of Object.values(errorMap)) {
      const list = Array.isArray(value) ? value : [value];
      for (const item of list) {
        const message = str(item) || str(asRecord(item)?.["message"]);
        if (message) return message;
      }
    }
  }
  for (const key of ["message", "error", "msg"]) {
    const raw = txn[key];
    const value = str(raw) || str(asRecord(raw)?.["message"]);
    if (value) return value;
  }
  return fallback;
}

export type PrimaryCreateNormalized = {
  id: string;
  status: string;
  qrCode: string;
  expirationDate: string;
};

const ID_KEYS = [
  "transaction_id",
  "transactionId",
  "txnId",
  "txn_id",
  "payment_id",
  "paymentId",
  "id",
];
const QR_KEYS = [
  "copy_paste",
  "pix_copy_paste",
  "pix_qrcode",
  "pixQrCode",
  "qrcode",
  "qr_code",
  "qrCode",
  "pix_code",
  "pixCode",
  "brcode",
  "br_code",
  "copyPaste",
  "copiaecola",
  "payload",
  "emv",
];

export function normalizePrimaryCreate(
  body: Record<string, unknown>,
): PrimaryCreateNormalized | null {
  const txn = unwrap(body);
  const pix = asRecord(txn["pix"]) ?? {};
  const id = firstId(txn, ID_KEYS);
  const qrCode =
    firstStr(txn, QR_KEYS) ||
    firstStr(pix, [
      // Hub: `pix.copyPaste` é o copia-e-cola e `pix.qrCode` é a imagem do QR
      // (vazia na Beehive/FreePay) — o texto tem de vir SEMPRE antes.
      "copyPaste",
      "copy_paste",
      "copiaECola",
      "qr_code",
      "qrcode",
      "qrCode",
      "pix_qrcode",
      "code",
      "payload",
    ]);
  if (!id || !qrCode) return null;
  const status =
    firstStr(txn, ["status", "payment_status", "paymentStatus", "situacao"]) || "pending";
  // A Beehive devolve a validade dentro de `pix` (`pix.expirationDate`).
  const expirationDate =
    firstStr(txn, ["expiration_date", "expirationDate", "expires_at", "expiresAt"]) ||
    firstStr(pix, ["expiration_date", "expirationDate", "expires_at", "expiresAt"]);
  return { id, status, qrCode, expirationDate };
}

// ─── status ───

const PAID_STATUSES = new Set([
  "PAID",
  "COMPLETED",
  "APPROVED",
  "CONFIRMED",
  "PAGO",
  "PAGA",
  "PAGAMENTO_CONFIRMADO",
  "SUCCESS",
  "SUCCEEDED",
]);

// Semântica documentada (v2.8: pending = aguardando confirmação,
// processing = em processamento → NÃO liberam; failed/rejected/cancelled/
// expired = terminais → nunca pagos, mesmo com paid_at preenchido).
// refused/refunded/chargeback vêm da Beehive e são igualmente terminais.
// WAITING_PAYMENT é o "pending" real da Beehive (observado na API: o status
// inicial de toda cobrança PIX é `waiting_payment`).
const UNPAID_STATUSES = new Set([
  "PENDING",
  "PROCESSING",
  "WAITING_PAYMENT",
  "UNDER_REVIEW",
  "AUTHORIZED",
  "FAILED",
  "REJECTED",
  "REFUSED",
  "CANCELLED",
  "CANCELED",
  "EXPIRED",
  "REFUNDED",
  "CHARGEBACK",
  "CHARGEDBACK",
]);

export function isPrimaryPaid(status: string, paidAt: string, paidFlag?: unknown): boolean {
  if (UNPAID_STATUSES.has(status.trim().toUpperCase())) return false;
  if (paidFlag === true) return true;
  if (PAID_STATUSES.has(status.trim().toUpperCase())) return true;
  const value = (paidAt || "").trim();
  return value !== "" && !value.startsWith("0001-01-01");
}

/** Status terminais que garantem que a cobrança não pode mais ser paga. Serve
 *  para liberar a renovação do Pix com segurança (o Pix só é refeito quando o
 *  anterior está morto). O hub não tem status "expired" — um Pix vencido chega
 *  como `failed`/`canceled`, por isso a lista é maior que `expired`. */
const UNPAYABLE_STATUSES = new Set([
  "EXPIRED",
  "FAILED",
  "CANCELED",
  "CANCELLED",
  "REJECTED",
  "REFUSED",
  "ERROR",
]);

export function primaryUnpayable(status: string): boolean {
  return UNPAYABLE_STATUSES.has(status.trim().toUpperCase());
}

export type PrimaryInfoNormalized = {
  id: string;
  status: string;
  paid: boolean;
  paidAt: string;
  amount: number; // centavos
  end2EndId: string;
  reference: string;
};

export function normalizePrimaryInfo(
  body: Record<string, unknown>,
  fallbackId: string,
  kind: GatewayKind,
): PrimaryInfoNormalized | null {
  const txn = unwrap(body);
  const pix = asRecord(txn["pix"]) ?? {};
  const id = firstId(txn, ID_KEYS) || fallbackId;
  const status = firstStr(txn, ["status", "payment_status", "paymentStatus", "situacao"]);
  if (!status && txn["paid"] !== true) return null;
  const paidAt = firstStr(txn, ["paid_at", "paidAt", "PaidAt", "confirmed_at", "confirmedAt"]);
  const amountRaw =
    txn["amount_cents"] ?? txn["amountCents"] ?? txn["Amount"] ?? txn["amount"] ?? txn["value"];
  let amount = typeof amountRaw === "number" && Number.isFinite(amountRaw) ? amountRaw : 0;
  // Gateways que informam em reais (ex: Vexigate) → normaliza p/ centavos.
  if (kind === "vexigate" && amount > 0) amount = Math.round(amount * 100);
  // A Beehive guarda o end-to-end dentro de `pix.end2EndId`.
  const end2EndId =
    firstStr(txn, ["e2e", "E2E", "End2End", "end_to_end", "endToEnd", "endToEndId"]) ||
    firstStr(pix, ["e2e", "end2EndId"]);
  return {
    id,
    status: status || "UNKNOWN",
    paid:
      kind === "paguex" || kind === "velani" || kind === "hub"
        ? status.trim().toLowerCase() === "paid"
        : isPrimaryPaid(status, paidAt, txn["paid"]),
    paidAt: paidAt.startsWith("0001-01-01") ? "" : paidAt,
    amount,
    end2EndId,
    reference: firstStr(txn, ["reference", "external_reference", "externalId", "externalRef"]),
  };
}

function statusCandidates(env: PrimaryEnv, id: string): string[] {
  const encoded = encodeURIComponent(id);
  const statusUrl = env.statusUrl;
  if (statusUrl) {
    if (statusUrl.includes("{id}")) return [statusUrl.split("{id}").join(encoded)];
    if (/[?&]id=$/.test(statusUrl)) return [`${statusUrl}${encoded}`];
    if (statusUrl.includes("?")) {
      return [`${statusUrl.replace(/\/*$/, "")}/${encoded}`, `${statusUrl}&id=${encoded}`];
    }
    return [
      `${statusUrl.replace(/\/*$/, "")}/${encoded}`,
      `${statusUrl.replace(/\/*$/, "")}?id=${encoded}`,
    ];
  }
  const base = env.createUrl.replace(/\/*$/, "");
  return [`${base}/${encoded}`, `${base}?id=${encoded}`];
}

/** Consulta o status no primário (tenta variações de URL). Null = sem resposta útil. */
export async function primaryStatus(
  id: string,
  env: PrimaryEnv,
): Promise<PrimaryInfoNormalized | null> {
  if (!env.configured) return null;
  for (const url of statusCandidates(env, id)) {
    const result = await getJson(url, env.apiKey, env.kind);
    if (!result || result.httpStatus === 404) continue;
    if (!isPrimarySuccess(result.httpStatus, result.data)) continue;
    const info = normalizePrimaryInfo(result.data, id, env.kind);
    if (info?.id === id) return info;
  }
  return null;
}

// ─── pós-processamento server-side ───

/** Registra uma Promise de pós-processamento (CAPI/webhook) no `waitUntil`
 *  do runtime quando disponível (Cloudflare `ctx.waitUntil`, Vercel/Nitro
 *  `event.waitUntil`), senão executa inline com timeout. Sem isso, Promises
 *  não aguardadas podem ser descartadas quando a hospedagem congela o
 *  handler após a resposta — o webhook responde 2xx mas a Purchase nunca sai.
 *
 *  No deploy atual (TanStack Start handlers sem acesso ao ctx), cai no
 *  branch inline: o trabalho é aguardado ANTES da resposta, com timeout
 *  curto para não estourar o limite da plataforma. */
export async function runBackground<T>(
  work: Promise<T>,
  opts?: { timeoutMs?: number },
): Promise<T | null> {
  const ctx = (
    globalThis as {
      __nitro__?: { h3?: { event?: { waitUntil?: (p: Promise<unknown>) => void } } };
    }
  ).__nitro__?.h3?.event;
  if (ctx?.waitUntil) {
    ctx.waitUntil(work.catch(() => undefined));
    return null;
  }
  const timeoutMs = opts?.timeoutMs ?? 15_000;
  try {
    return await Promise.race([
      work,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
    ]);
  } catch {
    return null;
  }
}

// ─── webhook ───

/** HMAC-SHA256 em hex (minúsculas). */
async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Comparação em tempo constante de dois hex (aceita também `sha256=<hex>`). */
function signatureMatches(expectedHex: string, providedRaw: string): boolean {
  const provided = providedRaw
    .trim()
    .replace(/^sha256=/i, "")
    .toLowerCase();
  if (expectedHex.length !== provided.length || expectedHex.length === 0) return false;
  let diff = 0;
  for (let i = 0; i < expectedHex.length; i++)
    diff |= expectedHex.charCodeAt(i) ^ provided.charCodeAt(i);
  return diff === 0;
}

/** Beehive não documenta assinatura HMAC no webhook (payload é
 *  `{ id, type, objectId, url, data }`, sem campo de assinatura). Nesses casos
 *  a única validação possível é confirmar a transação na API. */
export function webhookSignatureRequired(kind: GatewayKind): boolean {
  return kind !== "beehive";
}

/** Verifica a assinatura HMAC do webhook, por gateway.
 *
 *  vexigate/generic/hub: `sha256=<hmac-sha256(corpoBruto, secret)>` (doc v2.8 /
 *  hub: header `x-hub-signature`).
 *  velani (doc API v1.0): hex puro de `hmac-sha256(JSON.stringify(payload.data), whsec)`.
 *  Velani aceita somente o contrato documentado (data reserializado).
 *
 *  Sem segredo configurado não há como validar → retorna false (nega por padrão;
 *  o chamador decide o fallback). */
export async function verifyWebhookSignature(
  rawBody: string,
  signatureHeader: string | null,
  secret: string,
  kind: GatewayKind = "vexigate",
): Promise<boolean> {
  if (!secret || !signatureHeader) return false;
  if (kind !== "velani") {
    return signatureMatches(await hmacSha256Hex(secret, rawBody), signatureHeader);
  }
  try {
    const parsed = JSON.parse(rawBody) as unknown;
    const data = asRecord(parsed)?.["data"];
    if (data !== undefined) {
      return signatureMatches(await hmacSha256Hex(secret, JSON.stringify(data)), signatureHeader);
    }
  } catch {
    // corpo não-JSON é rejeitado pela validação de schema do chamador
  }
  return false;
}
