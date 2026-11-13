import type { PrimaryEnv } from "./pay-gateway.ts";

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** Uma compra do funil por documento/produto/valor. Não usa nome, e-mail,
 * telefone, clique ou dia. HMAC impede expor o CPF por hash enumerável. */
export async function pixOrderReference(
  document: string,
  product: string,
  amount: number,
  env: PrimaryEnv,
  renewFrom = "",
): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(env.apiKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sign = async (value: unknown) =>
    [
      ...new Uint8Array(
        await crypto.subtle.sign("HMAC", key, encoder.encode(JSON.stringify(value))),
      ),
    ]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  const base = `pix_${(await sign(["order-v1", env.kind, document, product, amount])).slice(0, 40)}`;
  return renewFrom ? `${base}_${(await sign(["renew-v1", renewFrom])).slice(0, 24)}` : base;
}

export function referenceBelongsToOrder(reference: string, base: string): boolean {
  return (
    reference === base ||
    (reference.startsWith(`${base}_`) && /^[a-f0-9]{24}$/.test(reference.slice(base.length + 1)))
  );
}

/** Coordenação e replay SOMENTE nesta instância. Não é lock distribuído nem
 * persistência. Não remover resultados incertos para liberar retries. */
export function createPixCreationGuard(
  options: {
    now?: () => number;
    maxEntries?: number;
    retentionMs?: number;
  } = {},
) {
  const now = options.now ?? Date.now;
  const maxEntries = options.maxEntries ?? 2000;
  const retention = options.retentionMs ?? RETENTION_MS;
  const entries = new Map<string, { until: number; running: boolean; result: Promise<Response> }>();

  return async function guardedCreate(
    reference: string,
    operation: () => Promise<Response>,
    recoverOnly = false,
  ): Promise<Response> {
    for (const [key, entry] of entries) {
      if (!entry.running && entry.until <= now()) entries.delete(key);
    }
    const previous = entries.get(reference);
    if (previous) return (await previous.result).clone();
    if (recoverOnly) {
      return Response.json(
        {
          success: false,
          orderId: reference,
          safeToRetry: false,
          unknown: true,
          message:
            "A criação anterior ainda não foi conciliada. Não gere outro Pix; informe esta referência ao suporte: " +
            reference,
        },
        { status: 409, headers: { "Cache-Control": "no-store" } },
      );
    }
    if (entries.size >= maxEntries) {
      return Response.json(
        {
          success: false,
          safeToRetry: true,
          message: "Criação temporariamente indisponível. Aguarde e tente novamente.",
        },
        { status: 503, headers: { "Cache-Control": "no-store" } },
      );
    }
    // Publica antes do primeiro await para agregar requisições concorrentes.
    const entry = {
      until: now() + retention,
      running: true,
      result: Promise.resolve(new Response()),
    };
    entries.set(reference, entry);
    entry.result = Promise.resolve()
      .then(operation)
      .catch(() =>
        Response.json(
          {
            success: false,
            orderId: reference,
            safeToRetry: false,
            unknown: true,
            message:
              "Não foi possível confirmar a criação. Informe a referência ao suporte: " + reference,
          },
          { status: 502, headers: { "Cache-Control": "no-store" } },
        ),
      )
      .finally(() => {
        entry.running = false;
      });
    return (await entry.result).clone();
  };
}
