import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
// Fallback FreePay DESATIVADO (somente Vexigate). Para reativar, descomente
// o import abaixo e os blocos marcados com "FREEPAY:" nesta rota.
// import {
//   freepayRequest,
//   isFreepaySuccess,
//   normalizeFreepayInfo,
//   resolveFreepayEnv,
// } from "../../../lib/freepay";
import {
  isPrimaryPaid,
  primaryStatus,
  resolvePrimaryEnv,
  runBackground,
  verifyWebhookSignature,
  webhookSignatureRequired,
} from "../../../lib/pay-gateway";
import { sendMetaCapiEvent } from "../../../lib/meta-capi";
import { gatewayForKind } from "../../../lib/payment-routing";
import { handleHubPaid } from "../../../lib/hub-webhook";
import { handlePaguexPaid } from "../../../lib/paguex-webhook";
import { handleVelaniPaid } from "../../../lib/velani-webhook";

// Webhook de pagamento do gateway configurado no env.
// Vexigate: { transaction_id, external_reference, type, method, status, amount, currency } (plano)
//   Assinatura X-Vexigate-Signature (HMAC-SHA256) validada se PIX_GATEWAY_WEBHOOK_SECRET existir.
// Velani:   { event, timestamp, data: { id, externalId, status, amount, ... }, signature, version, source }
//   Assinatura = HMAC-SHA256 hex de JSON.stringify(payload.data) com o whsec (vem no corpo).
// Beehive:  { id, type: "transaction", objectId, url, data: { id, status, amount, paidAt, ... } }
//   Sem assinatura documentada → confirmação apenas pela consulta à API.
// Hub:      { event: "charge.updated", charge: { id, gateway, status, amount, method, reference } }
//   Assinatura = header `x-hub-signature` ("sha256=" + HMAC-SHA256 hex do corpo bruto)
//   com HUB_WEBHOOK_SECRET; `event: "webhook.test"` é só o teste do painel.
// Valida pelo shape + consulta a transação na API antes de confiar.
// Fire Purchase na CAPI com event_id = Id da transação (mesmo id do navegador → dedup).

// Ids chegam como string (Velani/Vexigate) ou número (Beehive: `id: 282`).
const idField = z.union([z.string().max(160), z.number()]).optional();

const txDataSchema = z
  .object({
    id: idField,
    saleId: idField,
    externalId: z.string().max(160).optional(),
    status: z.string().max(40).optional(),
    amount: z.number().optional(),
    paymentMethod: z.string().max(30).optional(),
    customerName: z.string().max(200).optional(),
    customerEmail: z.string().max(200).optional(),
    paidAt: z.string().max(60).nullish(),
    rejectionReason: z.string().max(500).nullish(),
  })
  .passthrough();

// Hub de gateways: { event, charge: { id: "velani_abc123", gateway, status,
// amount (centavos), method, reference } } — sem `data` aninhado.
const hubChargeSchema = z
  .object({
    id: idField,
    gateway: z.string().max(40).optional(),
    status: z.string().max(40).optional(),
    amount: z.number().optional(),
    method: z.string().max(30).optional(),
    reference: z.string().max(200).optional(),
  })
  .passthrough();

const bodySchema = z
  .object({
    Id: idField,
    id: idField,
    txnId: idField,
    txn_id: idField,
    transaction_id: idField,
    transactionId: idField,
    payment_id: idField,
    type: z.string().max(40).optional(),
    Status: z.string().max(40).optional(),
    status: z.string().max(40).optional(),
    payment_status: z.string().max(40).optional(),
    paymentStatus: z.string().max(40).optional(),
    paid: z.boolean().optional(),
    PaidAt: z.string().max(60).optional(),
    paid_at: z.string().max(60).optional(),
    paidAt: z.string().max(60).optional(),
    Amount: z.number().optional(),
    amount: z.number().optional(),
    amount_cents: z.number().optional(),
    amountCents: z.number().optional(),
    PaymentMethod: z.string().max(30).optional(),
    E2E: z.string().max(160).optional(),
    // Velani (doc API v1.0)
    event: z.string().max(60).optional(),
    data: txDataSchema.optional(),
    signature: z.string().max(256).optional(),
    source: z.string().max(60).optional(),
    version: z.string().max(20).optional(),
    // Beehive (docs.beehivehub.io): { id, type, objectId, url, data }
    objectId: idField,
    // Hub de gateways: { event: "charge.updated", charge: { ... } }
    charge: hubChargeSchema.optional(),
  })
  .passthrough();

/** Normaliza um id que pode vir como string ou número. */
function asId(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

export const Route = createFileRoute("/api/public/sup-webhook")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const rawBody = await request.text();
        const env = (globalThis as { process?: { env?: Record<string, string | undefined> } })
          .process?.env;

        let raw: unknown;
        try {
          raw = JSON.parse(rawBody);
        } catch {
          return Response.json({ ok: false }, { status: 400 });
        }
        const parsed = bodySchema.safeParse(raw);
        if (!parsed.success) {
          console.error("[sup-webhook] payload inválido");
          return Response.json({ ok: false }, { status: 422 });
        }
        const payload = parsed.data;
        const nested = payload.data;
        const query = new URL(request.url).searchParams;
        const kind =
          query.get("gateway") ||
          (request.headers.has("x-hub-signature")
            ? "hub"
            : request.headers.has("x-paguex-signature")
              ? "paguex"
              : request.headers.has("x-vexigate-signature")
                ? "vexigate"
                : payload.event?.startsWith("transaction.")
                  ? "velani"
                  : payload.type === "transaction"
                    ? "beehive"
                    : resolvePrimaryEnv(env).kind);
        const gatewayEnv = gatewayForKind(kind, env);
        if (!gatewayEnv) return Response.json({ ok: false }, { status: 503 });

        // Assinatura HMAC. Vexigate (doc v2.8) manda X-Vexigate-Signature; a
        // Velani manda o campo `signature` no corpo; o hub manda x-hub-signature
        // ("sha256=" + HMAC do corpo bruto). Com segredo configurado a
        // verificação é obrigatória: sem assinatura válida, nega com 401. Sem
        // segredo não há como autenticar — loga o aviso e prossegue apenas com a
        // confirmação via API (fonte da verdade) abaixo.
        // A Beehive não documenta assinatura no webhook: nesse caso a validação
        // é sempre pela consulta à API.
        const signature =
          gatewayEnv.kind === "paguex"
            ? request.headers.get("x-paguex-signature")
            : gatewayEnv.kind === "hub"
              ? (request.headers.get("x-hub-signature") ?? request.headers.get("x-signature"))
              : (request.headers.get("x-vexigate-signature") ??
                request.headers.get("x-signature") ??
                request.headers.get("x-velani-signature") ??
                payload.signature ??
                null);
        if (gatewayEnv.kind === "paguex" && !gatewayEnv.webhookSecret) {
          console.error("[sup-webhook] Pague-X exige PIX_GATEWAY_WEBHOOK_SECRET");
          return Response.json({ ok: false }, { status: 503 });
        }
        // O hub SEMPRE assina (`x-hub-signature`); sem HUB_WEBHOOK_SECRET não há
        // como validar, então recusa pedindo correção do ambiente (o hub reenvia).
        if (gatewayEnv.kind === "hub" && !gatewayEnv.webhookSecret) {
          console.error("[sup-webhook] hub de gateways exige HUB_WEBHOOK_SECRET");
          return Response.json({ ok: false }, { status: 503 });
        }
        if (gatewayEnv.webhookSecret && webhookSignatureRequired(gatewayEnv.kind)) {
          const valid = await verifyWebhookSignature(
            rawBody,
            signature,
            gatewayEnv.webhookSecret,
            gatewayEnv.kind,
          );
          if (!valid) {
            console.error("[sup-webhook] assinatura ausente/inválida");
            return Response.json({ ok: false }, { status: 401 });
          }
        } else if (!webhookSignatureRequired(gatewayEnv.kind)) {
          console.warn(
            "[sup-webhook] gateway sem assinatura documentada no webhook; validando apenas via consulta API",
          );
        } else if (signature) {
          console.warn(
            "[sup-webhook] assinatura recebida mas sem segredo configurado; sem validar",
          );
        } else {
          console.warn("[sup-webhook] sem segredo HMAC; validando apenas via consulta API");
        }

        // ── Hub de gateways ──
        // O hub só avisa depois de confirmar o status na gateway, mas a API
        // continua sendo a fonte da verdade: handleHubPaid reconsulta antes de
        // disparar a Purchase. `webhook.test` (botão do painel) não é venda.
        if (gatewayEnv.kind === "hub") {
          const hubEvent = (payload.event ?? "").trim().toLowerCase();
          if (hubEvent !== "charge.updated") {
            console.log("[sup-webhook] hub: evento ignorado", hubEvent || "(sem event)");
            return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
          }
          const charge = payload.charge;
          const hubId = asId(charge?.id);
          if (!hubId) {
            console.error("[sup-webhook] hub: evento sem charge.id");
            return Response.json({ ok: false }, { status: 422 });
          }
          // Só Pix gera venda neste funil; boleto/cartão não são vendidos aqui.
          if (charge?.method && charge.method !== "pix") {
            return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
          }
          const hubStatus = (charge?.status ?? "").trim();
          const isPaid = isPrimaryPaid(hubStatus, "");
          console.log("[sup-webhook] hub", hubId, hubStatus || "?", isPaid ? "PAID" : "not-paid");
          if (!isPaid) {
            return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
          }
          return handleHubPaid(
            hubId,
            typeof charge?.amount === "number" ? charge.amount : undefined,
            gatewayEnv,
          );
        }

        // Eventos que não são de pagamento PIX (saque/payout) não geram Purchase.
        if (gatewayEnv.kind === "paguex" && nested?.paymentMethod !== "pix") {
          return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
        }
        // Vexigate manda type "cashin"; a Beehive manda "transaction".
        const type = (payload.type ?? "").trim().toLowerCase();
        if (type && type !== "cashin" && type !== "transaction") {
          return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
        }
        const event = (payload.event ?? "").trim().toLowerCase();
        if (
          gatewayEnv.kind === "paguex"
            ? event !== "sale.paid"
            : event && !event.startsWith("transaction.")
        ) {
          return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
        }

        // Ordem: id aninhado (Velani/Beehive), objectId (Beehive — o `id` da
        // raiz é o id do EVENTO, não da transação) e depois os campos planos.
        const id =
          (gatewayEnv.kind === "paguex" ? asId(nested?.saleId) : "") ||
          asId(nested?.id) ||
          asId(payload.objectId) ||
          asId(payload.Id) ||
          asId(payload.id) ||
          asId(payload.txnId) ||
          asId(payload.txn_id) ||
          asId(payload.transaction_id) ||
          asId(payload.transactionId) ||
          asId(payload.payment_id);
        const status = (
          nested?.status ??
          payload.Status ??
          payload.status ??
          payload.payment_status ??
          payload.paymentStatus ??
          ""
        ).trim();
        if (!id) {
          console.error("[sup-webhook] sem Id");
          return Response.json({ ok: false }, { status: 422 });
        }
        if (gatewayEnv.kind === "velani") {
          if (
            event !== "transaction.paid" ||
            (nested?.paymentMethod && nested.paymentMethod !== "pix")
          ) {
            return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
          }
          return handleVelaniPaid(id, nested?.amount, gatewayEnv);
        }
        const paidAtRaw =
          nested?.paidAt ?? payload.PaidAt ?? payload.paid_at ?? payload.paidAt ?? "";
        const paid = isPrimaryPaid(
          status,
          typeof paidAtRaw === "string" ? paidAtRaw : "",
          payload.paid,
        );
        console.log("[sup-webhook]", id, status || "?", paid ? "PAID" : "not-paid");

        if (paid) {
          if (gatewayEnv.kind === "paguex") {
            // Aguardar de verdade: sem Promise solta e sem engolir falhas com 200.
            // Reentregas usam o mesmo orderId na UTMify e eventId na Meta.
            return handlePaguexPaid(id, query.get("ctx"), gatewayEnv);
          }
          // Velani já retornou acima. Vexigate usa reais; Beehive, centavos.
          const rawAmount =
            nested?.amount ??
            payload.Amount ??
            payload.amount ??
            payload.amount_cents ??
            payload.amountCents;
          const amountNumber =
            typeof rawAmount === "number" && Number.isFinite(rawAmount) ? rawAmount : undefined;
          const amountInCents =
            gatewayEnv.kind === "beehive" ||
            payload.amount_cents !== undefined ||
            payload.amountCents !== undefined;
          const value =
            amountNumber === undefined
              ? undefined
              : amountInCents
                ? amountNumber / 100
                : amountNumber;

          // Confirma na API (fonte da verdade) antes de disparar a Purchase.
          // runBackground: usa waitUntil quando o runtime expõe (Cloudflare
          // ctx / Nitro h3 event); na Vercel o branch é inline com o timeout
          // abaixo. Não usar Promise solta: a hospedagem pode congelar o
          // handler após a resposta 2xx e a Purchase nunca sair.
          // Timeout folgado (primaryStatus tenta até 2 URLs × 20s + CAPI 10s).
          // Somente Vexigate: sem fallback FreePay (bloco FREEPAY abaixo).
          await runBackground(
            (async () => {
              try {
                if (!gatewayEnv.configured) {
                  console.error("[sup-webhook] gateway não configurado para validar", id);
                  return;
                }
                let confirmedAmount: number | undefined;
                let confirmedPaid = false;
                try {
                  const confirmed = await primaryStatus(id, gatewayEnv);
                  if (confirmed?.paid) {
                    confirmedPaid = true;
                    confirmedAmount = confirmed.amount > 0 ? confirmed.amount / 100 : undefined;
                  }
                } catch (error) {
                  console.error("[sup-webhook] consulta primária falhou", id, error);
                }
                // FREEPAY: validação via FreePay quando o primário não confirmar:
                // if (!confirmedPaid) {
                //   const freepayEnv = resolveFreepayEnv(env);
                //   if (!freepayEnv.publicKey || !freepayEnv.secretKey) {
                //     console.error("[sup-webhook] FreePay sem credenciais para validar", id);
                //     return;
                //   }
                //   const freepayResult = await freepayRequest(
                //     `/v1/payment-transaction/info/${encodeURIComponent(id)}`,
                //     {
                //       method: "GET",
                //       publicKey: freepayEnv.publicKey,
                //       secretKey: freepayEnv.secretKey,
                //     },
                //   );
                //   if (!isFreepaySuccess(freepayResult.httpStatus, freepayResult.data)) {
                //     console.error(
                //       "[sup-webhook] validação FreePay falhou",
                //       id,
                //       freepayResult.httpStatus,
                //     );
                //     return;
                //   }
                //   const freepayInfo = normalizeFreepayInfo(freepayResult.data, id);
                //   if (!freepayInfo.paid) {
                //     console.error("[sup-webhook] FreePay API diz não-pago, ignorando", id);
                //     return;
                //   }
                //   confirmedPaid = true;
                //   confirmedAmount = freepayInfo.amount > 0 ? freepayInfo.amount : undefined;
                // }
                if (!confirmedPaid) {
                  console.log("[sup-webhook] API não confirmou pagamento, ignorando", id);
                  return;
                }
                await sendMetaCapiEvent({
                  eventName: "Purchase",
                  eventId: id,
                  value: confirmedAmount ?? value,
                  eventSourceUrl: undefined,
                });
              } catch (error) {
                console.error("[sup-webhook] falha no pós-processamento", id, error);
              }
            })(),
            { timeoutMs: 55_000 },
          );
        }

        return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
      },
    },
  },
});
