import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { getClientIp, sendMetaCapiEvent } from "../../../lib/meta-capi";
import { runBackground } from "../../../lib/pay-gateway";

// Espelho do pixel do navegador (tracking-shared.js): recebe os eventos do topo
// do funil com o MESMO event_id usado no navegador e reenvia via Meta CAPI
// (deduplicação browser↔CAPI pelo event_id). Sem META_CAPI_TOKEN configurado,
// os eventos ficam registrados apenas no log do servidor.
const bodySchema = z.object({
  eventName: z.string().max(80),
  eventId: z.string().max(120),
  value: z.number().nonnegative().max(1_000_000).optional(),
  email: z.string().max(200).optional(),
  phone: z.string().max(40).optional(),
  nome: z.string().max(200).optional(),
  cpf: z.string().max(20).optional(),
  eid: z.string().max(80).optional(),
  fbp: z.string().max(255).nullable().optional(),
  fbc: z.string().max(255).nullable().optional(),
  eventSourceUrl: z.string().max(2000).optional(),
});

export const Route = createFileRoute("/api/public/sup-track")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        let raw: unknown;
        try {
          raw = await request.json();
        } catch {
          return Response.json({ ok: false }, { status: 400 });
        }
        // Endpoint de registro apenas: nunca rejeita o funil. Payload inválido
        // é logado no servidor (com os valores perdidos) e responde ok.
        const parsed = bodySchema.safeParse(raw);
        if (!parsed.success) {
          console.error("[sup-track] payload inválido", JSON.stringify(raw).slice(0, 500));
        } else {
          const { eventName, eventId, value } = parsed.data;
          console.log("[sup-track]", eventName, eventId, value ?? "");
          // Espelho CAPI com o MESMO event_id do navegador → dedup.
          // Via runBackground (waitUntil quando há, senão inline com timeout):
          // Promise solta pode ser descartada pela hospedagem após a resposta.
          await runBackground(
            sendMetaCapiEvent({
              eventName,
              eventId,
              value,
              email: parsed.data.email,
              phone: parsed.data.phone,
              nome: parsed.data.nome,
              cpf: parsed.data.cpf,
              eid: parsed.data.eid,
              fbp: parsed.data.fbp,
              fbc: parsed.data.fbc,
              clientIp: getClientIp(request),
              clientUa: request.headers.get("user-agent") ?? undefined,
              eventSourceUrl: parsed.data.eventSourceUrl,
            }),
            { timeoutMs: 8_000 },
          );
        }
        return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
      },
    },
  },
});
