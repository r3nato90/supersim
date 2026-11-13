import { primaryStatus } from "./pay-gateway.ts";
import type { PrimaryEnv } from "./pay-gateway.ts";
import { sendMetaCapiEvent } from "./meta-capi.ts";

/** Chamado somente APÓS validar `x-hub-signature` e o evento `charge.updated`.
 *
 *  O hub já confirma o status na gateway antes de avisar, mas a API continua
 *  sendo a fonte da verdade: reconsultamos por `id` antes de mandar a Purchase.
 *  Resposta: 2xx = processado (o hub não reenvia); 422 = divergência de valor
 *  (não dispara Purchase e marca o evento para investigação); 503 = falha
 *  transitória ou gateway não pago ainda — o hub reenfileira sozinho
 *  (backoff crescente, até ~12 tentativas) e o reenvio é idempotente porque a
 *  Purchase usa `event_id` = id da cobrança. */
export async function handleHubPaid(
  id: string,
  amount: number | undefined,
  gateway: PrimaryEnv,
): Promise<Response> {
  const reply = (status: number) =>
    Response.json({ ok: status === 200 }, { status, headers: { "Cache-Control": "no-store" } });
  try {
    const confirmed = await primaryStatus(id, gateway);
    if (!confirmed) return reply(503);
    if (!confirmed.paid) {
      // Vencido/cancelado/recusado já é o estado final: nada a fazer (2xx para
      // o hub não ficar reenviando). Ainda pendente (aguardando a gateway
      // liquidar) pede reentrega.
      const terminal = ["failed", "canceled", "cancelled", "refunded", "chargeback", "expired"];
      return reply(terminal.includes(confirmed.status.trim().toLowerCase()) ? 200 : 503);
    }
    // `amount` do webhook já vem em centavos (contrato do hub).
    if (!Number.isSafeInteger(confirmed.amount) || confirmed.amount <= 0) return reply(503);
    if (amount !== undefined && amount !== confirmed.amount) {
      console.error(
        "[sup-webhook] hub: valor do webhook diverge da API",
        id,
        amount,
        confirmed.amount,
      );
      return reply(422);
    }
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
    console.error("[sup-webhook] falha no processamento do hub; solicitar reenvio", id);
    return reply(503);
  }
}
