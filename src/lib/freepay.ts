// DESATIVADO: fallback FreePay desligado nas rotas sup-* (somente Vexigate).
// Módulo mantido intacto p/ reativação futura (descomentar imports + blocos "FREEPAY:").
// FreePay fallback for the SuperSim PIX funnel. Server-side only.
// Env vars: FREEPAY_PUBLIC_KEY, FREEPAY_SECRET_KEY, FREEPAY_POSTBACK_URL.
const FREEPAY_BASE_URL = "https://api.freepaybrasil.com";
const REQUEST_TIMEOUT_MS = 20_000;

export type FreepayEnv = {
  publicKey: string;
  secretKey: string;
  postbackUrl: string;
};

export function resolveFreepayEnv(env?: Record<string, string | undefined>): FreepayEnv {
  const e =
    env ??
    (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ??
    {};
  return {
    publicKey: (e["FREEPAY_PUBLIC_KEY"] ?? "").trim(),
    secretKey: (e["FREEPAY_SECRET_KEY"] ?? "").trim(),
    postbackUrl: (e["FREEPAY_POSTBACK_URL"] ?? "").trim(),
  };
}

export function shouldFallbackToFreepay(httpStatus: number): boolean {
  return httpStatus >= 400 && httpStatus < 500;
}

function base64Encode(value: string): string {
  const nodeBuffer = (
    globalThis as {
      Buffer?: { from(input: string, encoding: string): { toString(encoding: string): string } };
    }
  ).Buffer;
  return nodeBuffer
    ? nodeBuffer.from(value, "utf8").toString("base64")
    : btoa(unescape(encodeURIComponent(value)));
}

export function freepayAuthHeader(publicKey: string, secretKey: string): string {
  return `Basic ${base64Encode(`${publicKey}:${secretKey}`)}`;
}

export type FreepayResult = { httpStatus: number; data: Record<string, unknown> };

export async function freepayRequest(
  path: string,
  options: { method: "GET" | "POST"; body?: unknown; publicKey: string; secretKey: string },
): Promise<FreepayResult> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    Authorization: freepayAuthHeader(options.publicKey, options.secretKey),
  };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  const init: RequestInit = {
    method: options.method,
    headers,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  };
  if (options.body !== undefined) init.body = JSON.stringify(options.body);
  const response = await fetch(`${FREEPAY_BASE_URL}${path}`, init);
  let data: Record<string, unknown> = {};
  try {
    const parsed: unknown = await response.json();
    if (parsed && typeof parsed === "object") data = parsed as Record<string, unknown>;
  } catch {
    // Non-JSON gateway response.
  }
  return { httpStatus: response.status, data };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

export function unwrapFreepayData(body: Record<string, unknown>): Record<string, unknown> {
  return asRecord(body["data"]) ?? body;
}

export function isFreepaySuccess(httpStatus: number, body: Record<string, unknown>): boolean {
  return httpStatus >= 200 && httpStatus < 300 && body["success"] !== false;
}

export function freepayErrorMessage(body: Record<string, unknown>, fallback: string): string {
  const txn = unwrapFreepayData(body);
  const errors = txn["error_messages"];
  if (Array.isArray(errors)) {
    for (const item of errors) {
      const message =
        typeof item === "string" ? item.trim() : String(asRecord(item)?.["message"] ?? "").trim();
      if (message) return message;
    }
  }
  return typeof txn["message"] === "string" && txn["message"].trim()
    ? txn["message"].trim()
    : fallback;
}

export type FreepayCreateNormalized = {
  id: string;
  status: string;
  qrCode: string;
  expirationDate: string;
};

export function normalizeFreepayCreate(
  body: Record<string, unknown>,
): FreepayCreateNormalized | null {
  const txn = unwrapFreepayData(body);
  const pix = asRecord(txn["pix"]) ?? {};
  const id = typeof txn["id"] === "string" ? txn["id"].trim() : "";
  const qrCode = typeof pix["qr_code"] === "string" ? pix["qr_code"].trim() : "";
  if (!id || !qrCode) return null;
  return {
    id,
    status:
      typeof txn["status"] === "string" && txn["status"].trim() ? txn["status"].trim() : "PENDING",
    qrCode,
    expirationDate: typeof pix["expiration_date"] === "string" ? pix["expiration_date"] : "",
  };
}

export function isFreepayPaid(status: string, paidAt: string): boolean {
  return (
    status.toUpperCase() === "PAID" || (Boolean(paidAt.trim()) && !paidAt.startsWith("0001-01-01"))
  );
}

export type FreepayInfoNormalized = {
  id: string;
  status: string;
  paid: boolean;
  paidAt: string;
  amount: number;
  end2EndId: string;
};

export function normalizeFreepayInfo(
  body: Record<string, unknown>,
  fallbackId: string,
): FreepayInfoNormalized {
  const txn = asRecord(body["data"]) ?? body;
  const status = typeof txn["status"] === "string" ? txn["status"].trim() : "";
  const paidAtRaw = txn["paid_at"] ?? txn["paidAt"] ?? txn["PaidAt"];
  const paidAt = typeof paidAtRaw === "string" ? paidAtRaw.trim() : "";
  const amount = txn["amount"];
  const pix = asRecord(txn["pix"]) ?? {};
  const e2e = txn["e2_e"] ?? txn["E2E"] ?? txn["End2End"] ?? pix["e2e"];
  return {
    id: typeof txn["id"] === "string" && txn["id"].trim() ? txn["id"].trim() : fallbackId,
    status: status || "UNKNOWN",
    paid: isFreepayPaid(status, paidAt),
    paidAt: paidAt.startsWith("0001-01-01") ? "" : paidAt,
    amount: typeof amount === "number" && Number.isFinite(amount) ? amount : 0,
    end2EndId: typeof e2e === "string" ? e2e.trim() : "",
  };
}
