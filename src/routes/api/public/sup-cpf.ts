import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import {
  consultarCpf,
  cpfValido,
  excedeuRitmo,
  mascararCpf,
  resolveCpfEnv,
} from "../../../lib/cpf-brasil";
import { getClientIp } from "../../../lib/meta-capi";

// Consulta de CPF do funil (etapa 1 — public/inicio/2.html).
// Provedor padrão: Amnesia Tecnologia, via proxy server-side:
// GET {CPF_BASE_URL}/?token={CPF_API_KEY}&cpf={numeros} → 200 { DADOS: { nome, nome_mae,
// data_nascimento, sexo } } (ou { erro: "..." } / texto puro, sempre HTTP 200).
// `CPF_PROVIDER=zipcardx` volta para o provedor antigo (Bearer + /consult/{numeros}).
// Chave só server-side via CPF_API_KEY / CPF_BASE_URL / CPF_PROVIDER (nunca no navegador).
// Resposta: { success, encontrado, cpf, nome, mae, nascimento, sexo, confere? }.
// `nome` (query, opcional) ativa a conferência nome digitado x oficial,
// como no endpoint interno do outro projeto (api/consultar-cpf.php).
const querySchema = z.object({
  cpf: z.string().max(20).optional().default(""),
  nome: z.string().max(160).optional().default(""),
});

/** Igual ao CpfBrasil::nomeConfere do outro projeto: 1º e último nome (tokens >2). */
function nomeConfere(digitado: string, oficial: string): boolean {
  const limpar = (texto: string): string[] => {
    const semAcento = texto
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "");
    return semAcento
      .replace(/[^a-z\s]/g, " ")
      .split(/\s+/)
      .map((p) => p.trim())
      .filter((p) => p.length > 2);
  };
  const a = limpar(digitado);
  const b = limpar(oficial);
  if (!a.length || !b.length) return false;
  return a[0] === b[0] && a[a.length - 1] === b[b.length - 1];
}

export const Route = createFileRoute("/api/public/sup-cpf")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204 }),
      GET: async ({ request }) => {
        const noStore = { "Cache-Control": "no-store" };
        const url = new URL(request.url);
        const parsed = querySchema.safeParse({
          cpf: url.searchParams.get("cpf") ?? "",
          nome: url.searchParams.get("nome") ?? "",
        });
        const numeros = parsed.success ? parsed.data.cpf.replace(/\D/g, "").slice(0, 11) : "";
        if (!parsed.success || !cpfValido(numeros)) {
          return Response.json(
            { success: false, message: "CPF inválido." },
            { status: 422, headers: noStore },
          );
        }
        const nomeDigitado = parsed.success ? parsed.data.nome.trim() : "";

        const cpfEnv = resolveCpfEnv();
        if (!cpfEnv.apiKey || !cpfEnv.baseUrl) {
          console.error("[sup-cpf] CPF_API_KEY/CPF_BASE_URL ausentes no ambiente.");
          return Response.json(
            { success: false, message: "Consulta de CPF indisponível no momento." },
            { status: 503, headers: noStore },
          );
        }

        const ip = getClientIp(request);
        if (excedeuRitmo(ip || "sem-ip", cpfEnv.limitePorMinuto)) {
          return Response.json(
            {
              success: false,
              message: "Muitas consultas seguidas. Aguarde um minuto e tente de novo.",
            },
            { status: 429, headers: { ...noStore, "Retry-After": "60" } },
          );
        }

        const consulta = await consultarCpf(numeros, cpfEnv);
        if (!consulta.ok) {
          if (consulta.status === "rate-limit") {
            return Response.json(
              { success: false, retry: true, message: consulta.mensagem },
              { status: 429, headers: noStore },
            );
          }
          return Response.json(
            { success: false, message: consulta.mensagem },
            { status: 502, headers: noStore },
          );
        }

        if (!consulta.encontrado) {
          console.log("[sup-cpf] nao-encontrado", mascararCpf(numeros));
          return Response.json(
            {
              success: true,
              encontrado: false,
              cpf: numeros,
              nome: "",
              mae: "",
              nascimento: "",
              sexo: "",
              ...(nomeDigitado ? { confere: null as boolean | null } : {}),
            },
            { headers: noStore },
          );
        }

        return Response.json(
          {
            success: true,
            encontrado: true,
            cpf: numeros,
            nome: consulta.nome,
            mae: consulta.nomeMae,
            nascimento: consulta.nascimento,
            sexo: consulta.sexo,
            ...(nomeDigitado ? { confere: nomeConfere(nomeDigitado, consulta.nome) } : {}),
          },
          { headers: noStore },
        );
      },
    },
  },
});
