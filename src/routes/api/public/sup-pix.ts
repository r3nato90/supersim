import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { cpfValido } from "../../../lib/cpf-brasil";
import { getClientIp, sendMetaCapiEvent } from "../../../lib/meta-capi";
// Fallback FreePay DESATIVADO (somente Vexigate). Para reativar, descomente
// o import abaixo e os blocos marcados com "FREEPAY:" nesta rota.
// import {
//   freepayErrorMessage,
//   freepayRequest,
//   isFreepaySuccess,
//   normalizeFreepayCreate,
//   resolveFreepayEnv,
//   shouldFallbackToFreepay,
// } from "../../../lib/freepay";
import {
  isPrimarySuccess,
  maskPhone,
  normalizePrimaryCreate,
  primaryCreate,
  primaryStatus,
  primaryErrorMessage,
  primarySupportsAmount,
  primaryUnpayable,
  resolvePrimaryEnv,
  runBackground,
} from "../../../lib/pay-gateway";
// Catálogo/preços do funil: fonte única em src/lib/sup-products.ts.
import { PRODUCTS } from "../../../lib/sup-products";
import { resolveUtmifyEnv, sendUtmifyOrder, utcTimestamp } from "../../../lib/utmify";
import { sealPaymentContext } from "../../../lib/payment-context";
import {
  createPixCreationGuard,
  pixOrderReference,
  referenceBelongsToOrder,
} from "../../../lib/pix-order";

// PIX do funil SuperSim via gateway configurado no env (PIX_GATEWAY_API_KEY).
// Chaves só server-side; nunca expostas no navegador.
const PIX_EXPIRES_IN_DAYS = 1;
// Produção: usa os dados reais do cliente (obrigatórios).
const DEMO_MODE = false;

// Marca da versão desta rota (aparece em `build` nas respostas). Serve para
// provar qual código atendeu a requisição: 422/424 com `build` antigo = deploy
// antigo (aba aberta antes do deploy), não regressão do código.
const PIX_BUILD_TAG = "pix-2026-10-21-dedup-v2";
const guardedCreate = createPixCreationGuard();

// O funil envia null quando um parâmetro/cookie não existe
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
  upKey: z.string().max(40),
  nome: z.string().max(120).optional(),
  cpf: z.string().max(20).optional(),
  email: z.string().max(160).optional(),
  phone: z.string().max(20).optional(),
  eid: z.string().max(80).optional(),
  utms: utmsSchema,
  fbp: z.string().max(255).nullable().optional(),
  fbc: z.string().max(255).nullable().optional(),
  icEventId: z.string().max(100).optional(),
  leadEventId: z.string().max(100).optional(),
  clientOrderId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,79}$/),
  recoverOnly: z.boolean().optional(),
  renewFromTxnId: z
    // Ids do hub vêm como `<gateway>_<id>` (ex.: `velani_8f2a1c`), por isso `_`.
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/)
    .optional(),
  eventSourceUrl: z.string().max(2000).optional(),
});

function cleanText(value: unknown, maxLength = 160): string {
  return (
    String(value ?? "")
      // eslint-disable-next-line no-control-regex -- sanitiza caracteres de controle do input
      .replace(/[\u0000-\u001F\u007F<>]/g, "")
      .trim()
      .slice(0, maxLength)
  );
}

function digitsOnly(value: unknown, maxLength = 20): string {
  return String(value ?? "")
    .replace(/\D/g, "")
    .slice(0, maxLength);
}

function isValidEmail(value: string): boolean {
  return /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/.test(value.trim());
}

function bad(request: Request, message: string, status: number, extra?: Record<string, unknown>) {
  return Response.json(
    // `build` identifica a versão do código que respondeu. Sem isso não dá para
    // distinguir "o bug voltou" de "esta requisição foi atendida por um deploy
    // antigo" (aba aberta antes do deploy / skew protection da Vercel).
    { success: false, message, build: PIX_BUILD_TAG, ...extra },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

export const Route = createFileRoute("/api/public/sup-pix")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204 }),
      POST: async ({ request }) => {
        let raw: unknown;
        try {
          raw = await request.json();
        } catch {
          return bad(request, "Corpo inválido.", 400, { safeToRetry: true });
        }

        const parsed = bodySchema.safeParse(raw);
        if (!parsed.success) {
          console.error("[sup-pix] corpo rejeitado:", JSON.stringify(parsed.error.issues));
          return bad(request, "Corpo inválido.", 422, { safeToRetry: true });
        }
        const input = parsed.data;

        const product = PRODUCTS[input.upKey];
        if (!product) return bad(request, "Produto inválido.", 422, { safeToRetry: true });
        const amount = product.amount;
        if (amount < 500 || amount > 60000) {
          return bad(
            request,
            "O valor do produto está fora dos limites aceitos pelo gateway.",
            500,
          );
        }

        let name = cleanText(input.nome, 120);
        let email = isValidEmail(input.email ?? "") ? (input.email ?? "").trim().toLowerCase() : "";
        let phone = digitsOnly(input.phone, 15);
        let documentNumber = digitsOnly(input.cpf, 14);

        // Modo demo usa os dados públicos de teste da documentação.
        // Ao desativar DEMO_MODE, os dados reais passam a ser obrigatórios.
        if (DEMO_MODE) {
          if (!name) name = "João Silva";
          if (!email) email = "joao@example.com";
          if (!phone) phone = "5511999999999";
          if (!documentNumber) documentNumber = "12345678900";
        } else if (
          !name ||
          !email ||
          phone.length < 10 ||
          (documentNumber.length === 14
            ? !/^[0-9]{14}$/.test(documentNumber)
            : !cpfValido(documentNumber)) // igual ao Bebidas-Chabas (criar-pagamento.php:49)
        ) {
          const faltando: string[] = [];
          if (!name) faltando.push("nome");
          if (!email) faltando.push("e-mail");
          if (phone.length < 10) faltando.push("telefone");
          if (
            documentNumber.length === 14
              ? !/^[0-9]{14}$/.test(documentNumber)
              : !cpfValido(documentNumber)
          )
            faltando.push("cpf");
          console.error(
            "[sup-pix] dados do cliente incompletos:",
            faltando.join(","),
            "| upKey:",
            input.upKey,
          );
          return bad(
            request,
            `Faltam dados para gerar o Pix (${faltando.join(", ")}). Volte uma etapa e preencha novamente.`,
            422,
            { campos: faltando, safeToRetry: true },
          );
        }

        const documentType = documentNumber.length === 14 ? "cnpj" : "cpf";
        const primaryEnv = resolvePrimaryEnv();
        if (!primaryEnv.configured) {
          return bad(request, "Gateway de pagamento indisponível no momento.", 503, {
            safeToRetry: true,
          });
        }
        if (!primarySupportsAmount(primaryEnv, amount)) {
          return bad(
            request,
            "O valor do produto está abaixo do mínimo aceito pelo gateway.",
            422,
            { safeToRetry: true },
          );
        }
        const clientIp = getClientIp(request);
        const userAgent = request.headers.get("user-agent") ?? "";
        // O cliente não escolhe uma nova compra a cada clique nem muda a chave
        // corrigindo nome/contato. Uma renovação requer expiração na API.
        const baseReference = await pixOrderReference(
          documentNumber,
          product.externalRef,
          amount,
          primaryEnv,
        );
        if (input.renewFromTxnId) {
          let previous;
          try {
            previous = await primaryStatus(input.renewFromTxnId, primaryEnv);
          } catch {
            /* falha fechada */
          }
          if (
            !previous ||
            previous.amount !== amount ||
            !referenceBelongsToOrder(previous.reference, baseReference)
          ) {
            return bad(
              request,
              "Não foi possível validar o Pix anterior. Procure o suporte antes de gerar outro.",
              409,
            );
          }
          if (previous.paid || !primaryUnpayable(previous.status)) {
            return bad(
              request,
              "O Pix anterior não está confirmado como expirado. Não gere outro pagamento.",
              409,
            );
          }
        }
        const orderReference = input.renewFromTxnId
          ? await pixOrderReference(
              documentNumber,
              product.externalRef,
              amount,
              primaryEnv,
              input.renewFromTxnId,
            )
          : baseReference;
        // Origem da própria requisição (nunca um host arbitrário do navegador).
        const requestOrigin = (() => {
          try {
            return new URL(request.url).origin;
          } catch {
            return "";
          }
        })();
        const eventSourceUrl = cleanText(input.eventSourceUrl, 500);
        // A Beehive exige metadata.checkout_url e metadata.shop_url em toda
        // transação; sem eles a criação é invalidada. Usa a página de origem
        // quando é uma URL http(s) válida, senão a entrada do funil.
        const checkoutUrl = /^https?:\/\//i.test(eventSourceUrl)
          ? eventSourceUrl
          : requestOrigin
            ? `${requestOrigin}/inicio`
            : "";
        const metadata: Record<string, string> = {
          order_id: orderReference,
          product_key: input.upKey,
          shop_url: requestOrigin,
          checkout_url: checkoutUrl,
        };
        for (const [key, value] of Object.entries(input.utms)) {
          const clean = cleanText(value, 180);
          if (clean) metadata[key] = clean;
        }

        const orderPayload: Record<string, unknown> = {
          amount,
          payment_method: "pix",
          customer: {
            name,
            email,
            phone,
            document: { type: documentType, number: documentNumber },
          },
          items: [
            {
              title: product.title,
              unit_price: amount,
              quantity: 1,
              tangible: false,
              external_ref: product.externalRef,
            },
          ],
          pix: { expires_in_days: PIX_EXPIRES_IN_DAYS },
          metadata,
        };
        if (clientIp) orderPayload["ip"] = clientIp;

        const createdAt = utcTimestamp();
        if (primaryEnv.kind === "velani") {
          // Callback por transação, independente da configuração no painel.
          try {
            const callback = new URL(
              primaryEnv.postbackUrl || `${requestOrigin}/api/public/sup-webhook`,
            );
            if (callback.protocol !== "https:") throw new Error("HTTPS obrigatório");
            callback.searchParams.set("gateway", "velani");
            primaryEnv.postbackUrl = callback.toString();
          } catch {
            return bad(request, "Webhook de pagamento não configurado no servidor.", 503, {
              safeToRetry: true,
            });
          }
        }
        if (primaryEnv.kind === "paguex") {
          // Dados de conciliação autenticados e criptografados: nenhum CPF/email
          // em texto na URL. O webhook funciona mesmo se o comprador fechar a aba.
          try {
            const token = await sealPaymentContext(
              {
                reference: metadata["order_id"]!,
                createdAt,
                customer: {
                  name,
                  email,
                  phone,
                  document: documentNumber,
                  ...(clientIp ? { ip: clientIp } : {}),
                },
                product: { id: product.externalRef, name: product.title, priceInCents: amount },
                tracking: Object.fromEntries(
                  Object.entries(input.utms).map(([key, value]) => [key, value ?? null]),
                ),
              },
              process.env["PIX_PAYMENT_CONTEXT_SECRET"] || primaryEnv.webhookSecret,
            );
            const callback = new URL(
              primaryEnv.postbackUrl || `${requestOrigin}/api/public/sup-webhook`,
            );
            callback.searchParams.set("gateway", primaryEnv.kind);
            callback.searchParams.set("ctx", token);
            primaryEnv.postbackUrl = callback.toString();
          } catch {
            console.error("[sup-pix] não foi possível configurar o contexto seguro do webhook");
            return bad(request, "Integração de pagamento não configurada no servidor.", 503, {
              safeToRetry: true,
            });
          }
        }
        // FREEPAY: fallback desativado (somente Vexigate).
        // const freepayEnv = resolveFreepayEnv();
        // let gateway: string;
        let created: { id: string; status: string; qrCode: string; expirationDate: string } | null =
          null;
        // FREEPAY: const para o motivo do fallback.
        // let fallbackReason: string | null = null;

        return guardedCreate(
          orderReference,
          async () => {
            {
              if (primaryEnv.postbackUrl) orderPayload["postback_url"] = primaryEnv.postbackUrl;
              let result: { httpStatus: number; data: Record<string, unknown> };
              try {
                result = await primaryCreate(orderPayload, primaryEnv);
              } catch (error) {
                console.error(
                  "[sup-pix] falha de conexão com o gateway primário; sem fallback para evitar duplicidade",
                  error,
                );
                return bad(
                  request,
                  "Não foi possível confirmar a criação. Não gere outro Pix; consulte o suporte.",
                  502,
                  {
                    orderId: orderReference,
                    unknown: true,
                    safeToRetry: false,
                  },
                );
              }
              if (isPrimarySuccess(result.httpStatus, result.data)) {
                created = normalizePrimaryCreate(result.data);
                if (!created) {
                  console.error(
                    "[sup-pix] gateway primário retornou sucesso sem id/código PIX; fallback bloqueado",
                  );
                  return bad(
                    request,
                    "A transação foi criada, mas o gateway não retornou o identificador ou o código PIX.",
                    502,
                    { orderId: orderReference, unknown: true, safeToRetry: false },
                  );
                }
                // FREEPAY: chamar a FreePay quando o primário recusar de forma definitiva:
                // } else if (shouldFallbackToFreepay(result.httpStatus)) {
                //   fallbackReason = `rejeição HTTP ${result.httpStatus}`;
                //   console.error(
                //     "[sup-pix] gateway primário recusou; tentando FreePay",
                //     result.httpStatus,
                //     primaryErrorMessage(result.data, "Rejeição do gateway"),
                //   );
                //   gateway = "freepay";
              } else {
                const gatewayMessage = primaryErrorMessage(result.data, "Rejeição do gateway");
                console.error(
                  "[sup-pix] gateway primário recusou a cobrança",
                  result.httpStatus,
                  gatewayMessage,
                  // Sem o telefone no log não dá para dizer se a recusa foi do
                  // número: vai mascarado (tamanho + 4 últimos dígitos).
                  "| telefone:",
                  maskPhone(phone),
                );
                // 424/5xx = falha do gateway/adquirente, não do pedido. Ex.: a Beehive
                // devolve 424 "Resposta inválida da adquirente: código QR do Pix não
                // retornado" quando a adquirente recusa o pagador (CPF de teste tipo
                // 12345678909, por exemplo). O texto técnico vai só pro log: no
                // navegador ele viraria um alert() incompreensível para o cliente.
                const gatewayFault = result.httpStatus === 424 || result.httpStatus >= 500;
                return bad(
                  request,
                  gatewayFault
                    ? "Não foi possível confirmar a criação do Pix. Não gere outro pagamento; consulte o suporte."
                    : gatewayMessage,
                  result.httpStatus >= 400 && result.httpStatus <= 599 ? result.httpStatus : 502,
                  // `gateway` no erro: mostra qual adapter está ativo (diagnóstico de env).
                  // Não expõe chave nem URL — só o kind resolvido de PIX_GATEWAY.
                  {
                    gatewayHttpStatus: result.httpStatus,
                    orderId: orderReference,
                    unknown: true,
                    safeToRetry: false,
                    gateway: primaryEnv.kind,
                    // Só quando a mensagem exposta foi trocada por uma amigável.
                    gatewayMessage: gatewayFault ? gatewayMessage : undefined,
                  },
                );
              }
            }

            // FREEPAY: bloco de criação via FreePay (desativado — somente Vexigate).
            // if (gateway === "freepay") {
            //   if (!freepayEnv.publicKey || !freepayEnv.secretKey) {
            //     console.error(
            //       "[sup-pix] FreePay escolhida, mas credenciais ausentes.",
            //       fallbackReason ?? "gateway primário não configurado",
            //     );
            //     return bad(request, "Gateway de pagamento indisponível no momento.", 500);
            //   }
            //   const freepayPayload = { ...orderPayload };
            //   if (freepayEnv.postbackUrl) freepayPayload["postback_url"] = freepayEnv.postbackUrl;
            //   let result: { httpStatus: number; data: Record<string, unknown> };
            //   try {
            //     result = await freepayRequest("/v1/payment-transaction/create", {
            //       method: "POST",
            //       body: freepayPayload,
            //       publicKey: freepayEnv.publicKey,
            //       secretKey: freepayEnv.secretKey,
            //     });
            //   } catch (error) {
            //     console.error("[sup-pix] falha de conexão com a FreePay", error);
            //     return bad(request, "Falha de conexão com o gateway de pagamento.", 502);
            //   }
            //   if (!isFreepaySuccess(result.httpStatus, result.data)) {
            //     const message = freepayErrorMessage(result.data, "Não foi possível criar a transação.");
            //     console.error("[sup-pix] FreePay recusou", result.httpStatus, message);
            //     const status =
            //       result.httpStatus >= 400 && result.httpStatus <= 599 ? result.httpStatus : 502;
            //     return bad(request, message, status, { gatewayHttpStatus: result.httpStatus });
            //   }
            //   created = normalizeFreepayCreate(result.data);
            //   if (!created) {
            //     return bad(
            //       request,
            //       "A transação foi criada, mas o gateway não retornou o identificador ou o código PIX.",
            //       502,
            //     );
            //   }
            // }

            // ── UTMify: pedido criado (waiting_payment) ──
            // O orderId na UTMify é o `txnId` do gateway — o MESMO que o sup-utmify
            // envia depois no status "paid", então a UTMify atualiza o pedido em vez
            // de duplicar. O createdAt (UTC 0) precisa ser idêntico nas duas
            // chamadas: vai na resposta para o navegador reenviar no "paid".
            const utmifyEnv = resolveUtmifyEnv();
            const utmifyVenda = created
              ? {
                  orderId: created.id,
                  status: "waiting_payment" as const,
                  createdAt,
                  customer: {
                    name,
                    email,
                    phone,
                    document: documentNumber,
                    ...(clientIp ? { ip: clientIp } : {}),
                  },
                  product: {
                    id: product.externalRef,
                    name: product.title,
                    priceInCents: amount,
                  },
                  tracking: { ...input.utms },
                  isTest: DEMO_MODE,
                }
              : null;

            // Espelho CAPI server-side (InitiateCheckout + Lead) com os MESMOS event_ids
            // gerados no navegador → dedup browser↔CAPI. Via runBackground em
            // paralelo, com timeout curto: são redundantes com o pixel do navegador
            // (que já disparou), então não podem atrasar a resposta do QR.
            // Na Vercel o branch é inline — o acréscimo fica limitado a ~8s no pior
            // caso, tipicamente ~1s. A venda da UTMify entra no mesmo lote paralelo
            // (não aumenta o pior caso: os dois têm timeout de 8s).
            const capiBase = {
              email: email || undefined,
              phone: phone || undefined,
              nome: name || undefined,
              cpf: documentNumber || undefined,
              eid: cleanText(input.eid, 80) || undefined,
              fbp: input.fbp ?? undefined,
              fbc: input.fbc ?? undefined,
              clientIp: clientIp || undefined,
              clientUa: userAgent || undefined,
              eventSourceUrl: eventSourceUrl || undefined,
            };
            await runBackground(
              Promise.allSettled(
                [
                  input.icEventId
                    ? sendMetaCapiEvent({
                        ...capiBase,
                        eventName: "InitiateCheckout",
                        eventId: cleanText(input.icEventId, 100),
                        value: amount / 100,
                      })
                    : null,
                  input.leadEventId
                    ? sendMetaCapiEvent({
                        ...capiBase,
                        eventName: "Lead",
                        eventId: cleanText(input.leadEventId, 100),
                      })
                    : null,
                  utmifyEnv.token && utmifyVenda ? sendUtmifyOrder(utmifyVenda, utmifyEnv) : null,
                ].filter((p) => p !== null),
              ),
              { timeoutMs: 8_000 },
            );

            // Simplificação: removi a variável `gateway` (só Vexigate agora);
            // o campo da resposta usa primaryEnv.kind direto.
            if (!created) {
              return bad(
                request,
                "Não foi possível confirmar a criação. Consulte o suporte antes de gerar outro Pix.",
                502,
                {
                  orderId: orderReference,
                  unknown: true,
                  safeToRetry: false,
                },
              );
            }

            return Response.json(
              {
                success: true,
                txnId: created.id,
                status: created.status,
                amount: amount / 100,
                amountCents: amount,
                qrcode: created.qrCode,
                expiresAt: created.expirationDate || null,
                orderId: metadata["order_id"],
                // created_at (UTC 0) do pedido na UTMify: o navegador guarda e reenvia
                // no "paid" (a UTMify exige a mesma data na atualização).
                createdAt,
                gateway: primaryEnv.kind,
                build: PIX_BUILD_TAG,
              },
              { status: 201, headers: { "Cache-Control": "no-store" } },
            );
          },
          input.recoverOnly === true,
        );
      },
    },
  },
});
