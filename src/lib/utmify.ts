// Envio de vendas para a UTMify (docs.utmify.com.br/envio-de-vendas) — server-side only.
// POST {UTMIFY_ORDERS_URL} com header `x-api-token: {UTMIFY_API_TOKEN}`.
//
// Env:
//   UTMIFY_API_TOKEN   (credencial de API — Integrações > Webhooks > Credenciais de API)
//   UTMIFY_PLATFORM    (opcional; padrão "SuperSim") — nome da plataforma no painel
//   UTMIFY_ORDERS_URL  (opcional; padrão https://api.utmify.com.br/api-credentials/orders)
//
// Regras da UTMify respeitadas por este adapter:
//   - createdAt em UTC 0 e SEMPRE o mesmo valor em toda atualização do mesmo orderId;
//   - aceita pedidos de até 7 dias (45 dias p/ reembolso/chargeback);
//   - userCommissionInCents não pode ser 0 → sem taxa conhecida, = totalPriceInCents;
//   - a validação volta no corpo da resposta (a doc não lista status codes) → loga o corpo.

const REQUEST_TIMEOUT_MS = 8_000;
const DEFAULT_ORDERS_URL = "https://api.utmify.com.br/api-credentials/orders";

export type UtmifyEnv = {
  token: string;
  platform: string;
  ordersUrl: string;
};

export function resolveUtmifyEnv(env?: Record<string, string | undefined>): UtmifyEnv {
  const e =
    env ??
    (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ??
    {};
  return {
    token: (e["UTMIFY_API_TOKEN"] ?? "").trim(),
    platform: (e["UTMIFY_PLATFORM"] ?? "").trim() || "SuperSim",
    ordersUrl: (e["UTMIFY_ORDERS_URL"] ?? "").trim() || DEFAULT_ORDERS_URL,
  };
}

export type UtmifyStatus = "waiting_payment" | "paid" | "refused" | "refunded" | "chargedback";

export type UtmifyTracking = {
  src: string | null;
  sck: string | null;
  utm_source: string | null;
  utm_campaign: string | null;
  utm_medium: string | null;
  utm_content: string | null;
  utm_term: string | null;
};

export type UtmifyCustomer = {
  name: string;
  email: string;
  phone?: string;
  document?: string;
  ip?: string;
};

export type UtmifyProduct = {
  id: string;
  name: string;
  priceInCents: number;
};

/** Pedido do funil (front ou upsell) já normalizado para a UTMify. */
export type VendaSup = {
  orderId: string;
  status: UtmifyStatus;
  createdAt: string; // UTC 0 — "YYYY-MM-DD HH:MM:SS"
  approvedDate?: string | null;
  customer: UtmifyCustomer;
  product: UtmifyProduct;
  tracking?: Record<string, unknown>;
  isTest?: boolean;
};

const TRACKING_KEYS = [
  "src",
  "sck",
  "utm_source",
  "utm_campaign",
  "utm_medium",
  "utm_content",
  "utm_term",
] as const;

const p2 = (n: number): string => String(n).padStart(2, "0");

/** "YYYY-MM-DD HH:MM:SS" em UTC 0 (formato exigido pela UTMify). */
export function utcTimestamp(date: Date = new Date()): string {
  return (
    `${date.getUTCFullYear()}-${p2(date.getUTCMonth() + 1)}-${p2(date.getUTCDate())}` +
    ` ${p2(date.getUTCHours())}:${p2(date.getUTCMinutes())}:${p2(date.getUTCSeconds())}`
  );
}

const TS_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

/**
 * Valida o createdAt devolvido pelo navegador (o mesmo valor do `waiting_payment`,
 * como a UTMify exige). Formato inválido → null (o chamador usa "agora").
 */
export function parseUtcTimestamp(value: unknown): string | null {
  const v = String(value ?? "").trim();
  if (!TS_RE.test(v)) return null;
  const d = new Date(`${v.replace(" ", "T")}Z`);
  return Number.isNaN(d.getTime()) ? null : v;
}

function cortar(valor: string, max = 200): string {
  const t = valor.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

function textoUtm(valor: unknown, max = 300): string | null {
  const t = String(valor ?? "").trim();
  return t ? t.slice(0, max) : null;
}

export function buildTracking(utms?: Record<string, unknown>): UtmifyTracking {
  const origem = utms ?? {};
  const out = {} as UtmifyTracking;
  for (const key of TRACKING_KEYS) out[key] = textoUtm(origem[key]);
  return out;
}

export function buildUtmifyOrder(venda: VendaSup, env: UtmifyEnv): Record<string, unknown> {
  const cents = Math.max(0, Math.round(venda.product.priceInCents));
  const customer: Record<string, unknown> = {
    name: textoUtm(venda.customer.name, 200) ?? "",
    email: textoUtm(venda.customer.email, 200) ?? "",
    phone: textoUtm(venda.customer.phone, 20),
    document: textoUtm(venda.customer.document, 20),
    country: "BR",
  };
  const ip = textoUtm(venda.customer.ip, 60);
  if (ip) customer["ip"] = ip;

  return {
    orderId: venda.orderId,
    platform: env.platform,
    paymentMethod: "pix",
    status: venda.status,
    createdAt: venda.createdAt,
    approvedDate: venda.status === "paid" ? (venda.approvedDate ?? venda.createdAt) : null,
    refundedAt: venda.status === "refunded" ? (venda.approvedDate ?? null) : null,
    customer,
    products: [
      {
        id: venda.product.id,
        name: venda.product.name,
        planId: null,
        planName: null,
        quantity: 1,
        priceInCents: cents,
      },
    ],
    trackingParameters: buildTracking(venda.tracking),
    // Sem taxa de gateway conhecida: a doc permite userCommission = totalPrice.
    commission: {
      totalPriceInCents: cents,
      gatewayFeeInCents: 0,
      userCommissionInCents: cents,
    },
    ...(venda.isTest ? { isTest: true } : {}),
  };
}

export type UtmifyResult = {
  ok: boolean;
  httpStatus: number;
  detail: string;
};

/** Envia (ou atualiza) o pedido. Nunca lança: falha vira log + resultado. */
export async function sendUtmifyOrder(venda: VendaSup, env: UtmifyEnv): Promise<UtmifyResult> {
  if (!env.token) {
    console.warn("[utmify] UTMIFY_API_TOKEN ausente; venda não enviada", venda.orderId);
    return { ok: false, httpStatus: 0, detail: "UTMIFY_API_TOKEN ausente" };
  }

  let res: Response;
  try {
    res = await fetch(env.ordersUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-token": env.token },
      body: JSON.stringify(buildUtmifyOrder(venda, env)),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    console.error("[utmify] falha de conexao", venda.status, venda.orderId, error);
    return { ok: false, httpStatus: 0, detail: "falha de conexao" };
  }

  let corpo = "";
  try {
    corpo = await res.text();
  } catch {
    corpo = "";
  }
  const detail = cortar(corpo);
  if (!res.ok) {
    console.error("[utmify] recusou", venda.status, venda.orderId, res.status, detail);
    return { ok: false, httpStatus: res.status, detail };
  }
  console.log("[utmify] ok", venda.status, venda.orderId);
  return { ok: true, httpStatus: res.status, detail };
}
