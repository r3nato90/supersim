import { primaryStatus } from "./pay-gateway.ts";
import type { PrimaryEnv } from "./pay-gateway.ts";
import { openPaymentContext, contextVenda } from "./payment-context.ts";
import { resolveUtmifyEnv, sendUtmifyOrder, utcTimestamp } from "./utmify.ts";
import { sendMetaCapiEvent } from "./meta-capi.ts";

/** Chamado somente APÓS validar HMAC, evento e método PIX na rota. */
export async function handlePaguexPaid(
  id: string,
  token: string | null,
  gateway: PrimaryEnv,
): Promise<Response> {
  const reply = (status: number) =>
    Response.json({ ok: status === 200 }, { status, headers: { "Cache-Control": "no-store" } });
  try {
    const confirmed = await primaryStatus(id, gateway);
    if (!confirmed) return reply(503);
    if (!confirmed.paid) {
      const terminal = [
        "under_review",
        "refunded",
        "chargeback",
        "canceled",
        "cancelled",
        "refused",
        "expired",
      ];
      return reply(terminal.includes(confirmed.status.toLowerCase()) ? 200 : 503);
    }
    const context = token
      ? await openPaymentContext(
          token,
          process.env["PIX_PAYMENT_CONTEXT_SECRET"] || gateway.webhookSecret,
        )
      : null;
    if (token && !context) return reply(422);
    if (
      context &&
      (context.reference !== confirmed.reference ||
        context.product.priceInCents !== confirmed.amount)
    )
      return reply(422);
    const utmify = resolveUtmifyEnv();
    const tasks: Promise<boolean>[] = [];
    if (context && utmify.token) {
      const date = confirmed.paidAt ? new Date(confirmed.paidAt) : new Date();
      const approvedDate = utcTimestamp(Number.isNaN(date.getTime()) ? new Date() : date);
      tasks.push(
        sendUtmifyOrder(contextVenda(context, id, approvedDate), utmify).then(
          (result) => result.ok,
        ),
      );
    }
    if (process.env["META_CAPI_TOKEN"]) {
      tasks.push(
        sendMetaCapiEvent({
          eventName: "Purchase",
          eventId: id,
          value: confirmed.amount / 100,
          ...(context
            ? {
                email: context.customer.email,
                phone: context.customer.phone,
                nome: context.customer.name,
                cpf: context.customer.document,
              }
            : {}),
        }),
      );
    }
    const results = await Promise.all(tasks);
    return reply(results.every(Boolean) ? 200 : 503);
  } catch {
    console.error("[sup-webhook] falha no processamento Pague-X; solicitar reentrega", id);
    return reply(503);
  }
}
