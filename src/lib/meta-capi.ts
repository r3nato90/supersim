// Meta Conversions API (CAPI) — server-side only. Nunca expor o token no navegador.
// Usa Web Crypto (crypto.subtle) — funciona em Cloudflare Workers e Node 18+.
// Env vars:
//   META_PIXEL_ID        (padrão: pixel já usado no navegador)
//   META_CAPI_TOKEN      (token do pixel em Eventos > Configurações > API de Conversões)
//   META_TEST_EVENT_CODE (opcional: código de teste do Gerenciador de Eventos)
const DEFAULT_PIXEL_ID = "1497048498925446";
const GRAPH_VERSION = "v21.0";

type CapiUserInput = {
  email?: string | undefined;
  phone?: string | undefined;
  nome?: string | undefined;
  cpf?: string | undefined;
  eid?: string | undefined;
  fbp?: string | null | undefined;
  fbc?: string | null | undefined;
  clientIp?: string | undefined;
  clientUa?: string | undefined;
};

type CapiEventInput = CapiUserInput & {
  eventName: string;
  eventId: string;
  value?: number | undefined;
  currency?: string | undefined;
  eventSourceUrl?: string | undefined;
};

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function normEmail(email?: string): string | null {
  const v = (email ?? "").trim().toLowerCase();
  if (!/^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/.test(v)) return null;
  return v;
}

function normPhone(phone?: string): string | null {
  let d = (phone ?? "").replace(/\D/g, "");
  if (!d) return null;
  if (d.length <= 11 && !d.startsWith("55")) d = "55" + d;
  if (d.length < 10 || d.length > 15) return null;
  return d;
}

function normNameParts(nome?: string): { fn: string | null; ln: string | null } {
  const parts = (nome ?? "").trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!parts.length) return { fn: null, ln: null };
  const fn = parts[0] ?? null;
  const ln = parts.length > 1 ? (parts[parts.length - 1] ?? null) : null;
  return { fn, ln };
}

function normCpf(cpf?: string): string | null {
  const d = (cpf ?? "").replace(/\D/g, "");
  if (d.length !== 11 && d.length !== 14) return null;
  return d;
}

function normExternalId(eid?: string): string | null {
  const v = (eid ?? "").trim().toLowerCase();
  if (!v || v.length < 3) return null;
  return v;
}

export function resolveMetaEnv(env?: Record<string, string | undefined>) {
  const e =
    env ??
    ((globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ??
      {});
  const pixelId = (e["META_PIXEL_ID"] ?? "").trim() || DEFAULT_PIXEL_ID;
  // Remove aspas acidentais ("token" / 'token') — erro comum ao colar na Vercel.
  const token = (e["META_CAPI_TOKEN"] ?? "")
    .trim()
    .replace(/^['"]+|['"]+$/g, "");
  const testCode = (e["META_TEST_EVENT_CODE"] ?? "").trim();
  return { pixelId, token, testCode };
}

/** Envia 1 evento para a Meta via CAPI. Nunca lança exceção (fire-and-forget do funil). */
export async function sendMetaCapiEvent(input: CapiEventInput): Promise<boolean> {
  const { pixelId, token, testCode } = resolveMetaEnv();
  if (!token) {
    console.log(
      "[meta-capi] sem META_CAPI_TOKEN — evento só no navegador:",
      input.eventName,
      input.eventId
    );
    return false;
  }

  try {
    const user_data: Record<string, unknown> = {};
    const em = normEmail(input.email);
    const ph = normPhone(input.phone);
    const { fn, ln } = normNameParts(input.nome);
    const cpf = normCpf(input.cpf);
    const eid = normExternalId(input.eid);
    if (em) user_data["em"] = [await sha256Hex(em)];
    if (ph) user_data["ph"] = [await sha256Hex(ph)];
    if (fn) user_data["fn"] = [await sha256Hex(fn)];
    if (ln) user_data["ln"] = [await sha256Hex(ln)];
    const external_id: string[] = [];
    if (cpf) external_id.push(await sha256Hex(cpf));
    if (eid) external_id.push(await sha256Hex(eid));
    if (external_id.length) user_data["external_id"] = external_id;
    if (input.fbp) user_data["fbp"] = input.fbp;
    if (input.fbc) user_data["fbc"] = input.fbc;
    if (input.clientIp) user_data["client_ip_address"] = input.clientIp;
    if (input.clientUa) user_data["client_user_agent"] = input.clientUa;

    const custom_data: Record<string, unknown> = {};
    if (typeof input.value === "number" && Number.isFinite(input.value)) {
      custom_data["value"] = Math.round(input.value * 100) / 100;
      custom_data["currency"] = input.currency || "BRL";
    }

    const body: Record<string, unknown> = {
      data: [
        {
          event_name: input.eventName,
          event_time: Math.floor(Date.now() / 1000),
          event_id: input.eventId,
          event_source_url: input.eventSourceUrl,
          action_source: "website",
          user_data,
          ...(Object.keys(custom_data).length ? { custom_data } : {}),
        },
      ],
    };
    if (testCode) body["test_event_code"] = testCode;

    const res = await fetch(
      `https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(pixelId)}/events?access_token=${encodeURIComponent(token)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      }
    );
    if (!res.ok) {
      console.error("[meta-capi] Meta recusou", res.status, (await res.text()).slice(0, 500));
      return false;
    }
    return true;
  } catch (error) {
    console.error("[meta-capi] falha de conexao com a Meta", error);
    return false;
  }
}

export function getClientIp(request: Request): string {
  const h = request.headers;
  return (
    h.get("cf-connecting-ip")?.trim() ||
    h.get("true-client-ip")?.trim() ||
    h.get("x-forwarded-for")?.split(",", 1)[0]?.trim() ||
    h.get("x-real-ip")?.trim() ||
    ""
  );
}
