const CLOAK_API_URL = "http://cloakforge.app.br/api/cloak/decide";

const CLOAK_SLUG = "curated-trail";

// Chave do cloak — server-side only (nunca é enviada ao navegador).
// Variável CLOAK_API_KEY no ambiente sobrescreve este valor.
const CLOAK_KEY = "7EIKQDU7fxEw8FO1RJzhr0osD_O4QEdY";

const REQUEST_TIMEOUT_MS = 5_000;

function getClientIp(request: Request): string {
  const headers = request.headers;

  const cfIp = headers.get("cf-connecting-ip")?.trim();
  if (cfIp) return cfIp;

  const trueClientIp = headers.get("true-client-ip")?.trim();
  if (trueClientIp) return trueClientIp;

  const vercelForwardedFor = headers.get("x-vercel-forwarded-for")?.split(",", 1)[0]?.trim();
  if (vercelForwardedFor) return vercelForwardedFor;

  const realIp = headers.get("x-real-ip")?.trim();
  if (realIp) return realIp;

  const forwardedFor = headers.get("x-forwarded-for")?.split(",", 1)[0]?.trim();
  if (forwardedFor) return forwardedFor;

  return headers.get("fly-client-ip")?.trim() ?? "";
}

export async function decideCloak(
  request: Request,
  apiKey: string | undefined,
  fetcher: typeof fetch = fetch,
): Promise<boolean> {
  const key = apiKey?.trim() || CLOAK_KEY;
  const ip = getClientIp(request);
  if (!key || !ip) return false;

  const url = new URL(CLOAK_API_URL);
  url.searchParams.set("slug", CLOAK_SLUG);
  url.searchParams.set("key", key);
  url.searchParams.set("ip", ip);
  url.searchParams.set("ua", request.headers.get("user-agent") ?? "");
  url.searchParams.set("url", request.url);
  url.searchParams.set("ref", request.headers.get("referer") ?? "");
  url.searchParams.set("lang", request.headers.get("accept-language") ?? "");

  try {
    const response = await fetcher(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      redirect: "follow",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) return false;

    const payload: unknown = await response.json();
    return (
      typeof payload === "object" &&
      payload !== null &&
      "action" in payload &&
      payload.action === "allow"
    );
  } catch {
    return false;
  }
}

export function resolveCloakApiKey(
  runtimeEnv: unknown,
  serverEnv?: Record<string, string | undefined>,
): string | undefined {
  const workerEnv = (globalThis as typeof globalThis & { __env__?: unknown }).__env__;

  for (const candidate of [runtimeEnv, workerEnv]) {
    if (typeof candidate === "object" && candidate !== null && "CLOAK_API_KEY" in candidate) {
      const value = candidate.CLOAK_API_KEY;
      if (typeof value === "string" && value.trim()) return value;
    }
  }

  const processEnv =
    serverEnv ??
    (
      globalThis as typeof globalThis & {
        process?: { env?: Record<string, string | undefined> };
      }
    ).process?.env;

  const processValue = processEnv?.["CLOAK_API_KEY"];
  if (typeof processValue === "string" && processValue.trim()) return processValue;

  return undefined;
}

export async function gateHomeRequest(
  request: Request,
  apiKey: string | undefined,
  whitePageHtml: string,
  fetcher: typeof fetch = fetch,
): Promise<Response | null> {
  const requestUrl = new URL(request.url);

  if (request.method !== "GET" || requestUrl.pathname !== "/") return null;

  const allowed = await decideCloak(request, apiKey, fetcher);
  if (allowed) return null;

  return new Response(whitePageHtml, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
