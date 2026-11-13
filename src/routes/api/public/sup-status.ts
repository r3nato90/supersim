import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
// Fallback FreePay DESATIVADO (somente Vexigate). Para reativar, descomente
// o import abaixo e os blocos marcados com "FREEPAY:" nesta rota.
// import {
//   freepayErrorMessage,
//   freepayRequest,
//   isFreepaySuccess,
//   normalizeFreepayInfo,
//   resolveFreepayEnv,
// } from "../../../lib/freepay";
import { primaryUnpayable, resolvePrimaryEnv } from "../../../lib/pay-gateway";
import { lookupPayment } from "../../../lib/payment-routing";

// Consulta de status da transação no gateway configurado no env.
// paid = status pago/confirmado (ou paid_at válido).
const idSchema = z
  .string()
  .max(160)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/);

export const Route = createFileRoute("/api/public/sup-status")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const parsed = idSchema.safeParse(new URL(request.url).searchParams.get("id") ?? "");
        if (!parsed.success) {
          return Response.json(
            { success: false, message: "Identificador de transação inválido." },
            { status: 422 },
          );
        }

        const gatewayEnv = resolvePrimaryEnv();
        // Somente Vexigate: sem fallback FreePay. Se a consulta falhar,
        // o navegador repete o polling (retry=true).
        try {
          const match = await lookupPayment(
            parsed.data,
            new URL(request.url).searchParams.get("gateway") ?? "",
          );
          const info = match?.info;
          if (info) {
            return Response.json(
              {
                success: true,
                txnId: info.id,
                status: info.status,
                paid: info.paid,
                paidAt: info.paidAt || null,
                end2EndId: info.end2EndId || null,
                // A cobrança não pode mais ser paga (vencida/cancelada/recusada):
                // é seguro gerar outro Pix. O hub não tem status "expired", então
                // o navegador usa este campo em vez de comparar o texto.
                renewable: !info.paid && primaryUnpayable(info.status),
                gateway: match.gateway.kind,
              },
              { headers: { "Cache-Control": "no-store" } },
            );
          }
        } catch (error) {
          console.error("[sup-status] consulta do primário falhou", error);
        }
        if (!gatewayEnv.configured) {
          return Response.json(
            {
              success: false,
              paid: false,
              message: "Gateway de pagamento indisponível no momento.",
            },
            { status: 500, headers: { "Cache-Control": "no-store" } },
          );
        }
        return Response.json(
          {
            success: false,
            paid: false,
            retry: true,
            message: "Ainda não identificamos o pagamento. Tente de novo em instantes.",
            // Diagnóstico de env: qual adapter está ativo (não expõe chave/URL).
            gateway: gatewayEnv.kind,
            configured: gatewayEnv.configured,
          },
          { status: 502, headers: { "Cache-Control": "no-store" } },
        );

        // FREEPAY: consulta de status via FreePay (desativado — somente Vexigate).
        // const freepayEnv = resolveFreepayEnv();
        // if (!freepayEnv.publicKey || !freepayEnv.secretKey) {
        //   return Response.json(
        //     {
        //       success: false,
        //       paid: false,
        //       message: "Gateway de pagamento indisponível no momento.",
        //     },
        //     { status: 500, headers: { "Cache-Control": "no-store" } },
        //   );
        // }
        //
        // let result: { httpStatus: number; data: Record<string, unknown> };
        // try {
        //   result = await freepayRequest(
        //     `/v1/payment-transaction/info/${encodeURIComponent(parsed.data)}`,
        //     {
        //       method: "GET",
        //       publicKey: freepayEnv.publicKey,
        //       secretKey: freepayEnv.secretKey,
        //     },
        //   );
        // } catch (error) {
        //   console.error("[sup-status] falha de conexão com a FreePay", error);
        //   return Response.json(
        //     {
        //       success: false,
        //       paid: false,
        //       message: "Falha de conexão com o gateway de pagamento.",
        //     },
        //     { status: 502 },
        //   );
        // }
        // if (!isFreepaySuccess(result.httpStatus, result.data)) {
        //   const retry = result.httpStatus === 404 || result.httpStatus === 429;
        //   return Response.json(
        //     {
        //       success: false,
        //       paid: false,
        //       retry,
        //       message: freepayErrorMessage(
        //         result.data,
        //         "Ainda não identificamos o pagamento. Tente de novo em instantes.",
        //       ),
        //     },
        //     { status: retry ? result.httpStatus : 502, headers: { "Cache-Control": "no-store" } },
        //   );
        // }
        // const info = normalizeFreepayInfo(result.data, parsed.data);
        // return Response.json(
        //   {
        //     success: true,
        //     txnId: info.id,
        //     status: info.status,
        //     paid: info.paid,
        //     paidAt: info.paidAt || null,
        //     end2EndId: info.end2EndId || null,
        //     gateway: "freepay",
        //   },
        //   { headers: { "Cache-Control": "no-store" } },
        // );
      },
    },
  },
});
