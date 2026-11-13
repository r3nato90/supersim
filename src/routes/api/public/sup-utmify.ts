import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { getClientIp } from "../../../lib/meta-capi";
import { primaryStatus, resolvePrimaryEnv } from "../../../lib/pay-gateway";
import { lookupPayment } from "../../../lib/payment-routing";
import { PRODUCTS } from "../../../lib/sup-products";
import {
  parseUtcTimestamp,
  resolveUtmifyEnv,
  sendUtmifyOrder,
  utcTimestamp,
} from "../../../lib/utmify";

// Confirmação de venda PAGA do funil para a UTMify (etapa final do Pix).
//
// Fluxo: o navegador (checkout-shared.js → _pixFirePurchase) chama esta rota
// quando o pagamento confirma. Aqui o pagamento é REVALIDADO no gateway antes
// de qualquer envio — o navegador nunca decide sozinho que a venda foi paga.
// O orderId na UTMify é o `txnId` do gateway, o MESMO usado no waiting_payment
// enviado por sup-pix → a UTMify atualiza o pedido em vez de duplicar.
// O createdAt vem do navegador (o mesmo do waiting_payment, como a UTMify exige);
// se não vier, usa "agora" em UTC.

const idSchema = z
  .string()
  .max(160)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/);

// O funil envia null quando um parâmetro/cookie não existe.
const utmStr = z.string().max(180).nullable().optional();
const utmsSchema = z
  .object({
    utm_source: utmStr,
    utm_medium: utmStr,
    utm_campaign: utmStr,
    utm_term: utmStr,
    utm_content: utmStr,
    src: utmStr,
    sck: utmStr,
  })
  .default({});

const bodySchema = z.object({
  txnId: idSchema,
  gateway: z.string().max(20).optional(),
  upKey: z.string().max(40),
  createdAt: z.string().max(30).optional(),
  nome: z.string().max(200).optional(),
  email: z.string().max(200).optional(),
  phone: z.string().max(20).optional(),
  cpf: z.string().max(20).optional(),
  utms: utmsSchema,
});

function bad(message: string, status: number, extra?: Record<string, unknown>) {
  return Response.json(
    { success: false, sent: false, message, ...extra },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

function digitsOnly(value: unknown, maxLength = 20): string {
  return String(value ?? "")
    .replace(/\D/g, "")
    .slice(0, maxLength);
}

function cleanText(value: unknown, maxLength = 200): string {
  return (
    String(value ?? "")
      // eslint-disable-next-line no-control-regex -- sanitiza caracteres de controle do input
      .replace(/[\u0000-\u001F\u007F<>]/g, "")
      .trim()
      .slice(0, maxLength)
  );
}

export const Route = createFileRoute("/api/public/sup-utmify")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204 }),
      POST: async ({ request }) => {
        let raw: unknown;
        try {
          raw = await request.json();
        } catch {
          return bad("Corpo inválido.", 400);
        }

        const parsed = bodySchema.safeParse(raw);
        if (!parsed.success) {
          console.error("[sup-utmify] corpo rejeitado:", JSON.stringify(parsed.error.issues));
          return bad("Corpo inválido.", 422);
        }
        const input = parsed.data;

        // Preço e nome do produto sempre do catálogo do servidor (nunca do navegador).
        const produto = PRODUCTS[input.upKey];
        if (!produto) return bad("Produto inválido.", 422);

        const nome = cleanText(input.nome, 200);
        const email = cleanText(input.email, 200);
        if (!nome || !email) {
          return bad("Faltam dados do cliente para registrar a venda.", 422);
        }

        const utmifyEnv = resolveUtmifyEnv();
        if (!utmifyEnv.token) {
          console.error("[sup-utmify] UTMIFY_API_TOKEN ausente no ambiente.");
          return bad("Integração de vendas indisponível no momento.", 503);
        }

        const gatewayEnv = resolvePrimaryEnv();
        let resolvedGateway = gatewayEnv.kind;

        // Fonte da verdade: o gateway confirma que ESTE txnId está pago.
        let info: Awaited<ReturnType<typeof primaryStatus>> = null;
        try {
          const match = await lookupPayment(input.txnId, input.gateway);
          info = match?.info ?? null;
          if (match) resolvedGateway = match.gateway.kind;
        } catch (error) {
          console.error("[sup-utmify] consulta ao gateway falhou", input.txnId, error);
          return bad("Falha de conexão com o gateway de pagamento.", 502);
        }
        if (!info || !info.paid) {
          console.log("[sup-utmify] venda não confirmada pelo gateway", input.txnId);
          return bad("Pagamento ainda não confirmado.", 409, { paid: false });
        }

        const amountCents = info.amount > 0 ? info.amount : produto.amount;
        const createdAt = parseUtcTimestamp(input.createdAt) ?? utcTimestamp();
        const ip = getClientIp(request);

        const result = await sendUtmifyOrder(
          {
            orderId: input.txnId,
            status: "paid",
            createdAt,
            approvedDate: utcTimestamp(),
            customer: {
              name: nome,
              email,
              phone: digitsOnly(input.phone, 15),
              document: digitsOnly(input.cpf, 14),
              ...(ip ? { ip } : {}),
            },
            product: {
              id: produto.externalRef,
              name: produto.title,
              priceInCents: amountCents,
            },
            tracking: input.utms,
          },
          utmifyEnv,
        );

        return Response.json(
          {
            success: result.ok,
            sent: result.ok,
            paid: true,
            gateway: resolvedGateway,
            utmifyHttpStatus: result.httpStatus,
            ...(result.ok ? {} : { message: result.detail }),
          },
          { headers: { "Cache-Control": "no-store" } },
        );
      },
    },
  },
});
