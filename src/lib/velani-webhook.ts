import { primaryStatus } from "./pay-gateway.ts";
import type { PrimaryEnv } from "./pay-gateway.ts";
import { sendMetaCapiEvent } from "./meta-capi.ts";

/** A rota valida assinatura/evento. Falhas transitórias pedem reentrega à Velani. */
export async function handleVelaniPaid(
  id: string,
  amount: number | undefined,
  gateway: PrimaryEnv,
): Promise<Response> {
  const reply = (status: number) => Response.json(
    { ok: status === 200 },
    { status, headers: { "Cache-Control": "no-store" } },
  );
  try {
    const confirmed = await primaryStatus(id, gateway);
    if (!confirmed) return reply(503);
    if (!confirmed.paid) {
      return reply(["failed", "expired", "refunded"].includes(
        confirmed.status.trim().toLowerCase(),
      ) ? 200 : 503);
    }
    if (!Number.isSafeInteger(confirmed.amount) || confirmed.amount <= 0) return reply(503);
    if (amount !== undefined && amount !== confirmed.amount) return reply(422);
    if (process.env["META_CAPI_TOKEN"]) {
      const sent = await sendMetaCapiEvent({
        eventName: "Purchase",
        eventId: id,
        value: confirmed.amount / 100,
      });
      if (!sent) return reply(503);
    }
    return reply(200);
  } catch {
    console.error("[sup-webhook] falha Velani; solicitar reentrega", id);
    return reply(503);
  }
}
