// Credenciais históricas só no servidor; nunca usar URLs/chaves fornecidas pelo navegador.
import { primaryStatus, resolvePrimaryEnv } from "./pay-gateway.ts";
import type { GatewayKind, PrimaryEnv } from "./pay-gateway.ts";

const kinds: GatewayKind[] = ["vexigate", "velani", "beehive", "paguex", "hub", "generic"];

export function gatewayForKind(kind: string, env = process.env): PrimaryEnv | null {
  if (!kinds.includes(kind as GatewayKind)) return null;
  const active = resolvePrimaryEnv(env);
  if (active.kind === kind && active.configured) return active;
  // O hub não tem credencial "histórica" por gateway: as chaves dele são as
  // HUB_* e continuam valendo para consultar cobranças antigas.
  if (kind === "hub") {
    const hub = resolvePrimaryEnv({ ...env, PIX_GATEWAY: "hub" });
    return hub.configured ? hub : null;
  }
  const prefix = `PIX_GATEWAY_${kind.toUpperCase()}_`;
  const oldEnv: Record<string, string | undefined> = { PIX_GATEWAY: kind };
  for (const field of [
    "API_KEY",
    "CREATE_URL",
    "STATUS_URL",
    "POSTBACK_URL",
    "WEBHOOK_SECRET",
    "MIN_AMOUNT_CENTS",
  ]) {
    oldEnv[`PIX_GATEWAY_${field}`] = env[`${prefix}${field}`];
  }
  const historical = resolvePrimaryEnv(oldEnv);
  return historical.configured ? historical : null;
}

export async function lookupPayment(id: string, hint = "", env = process.env) {
  const candidates = hint
    ? [gatewayForKind(hint, env)].filter((g): g is PrimaryEnv => g !== null)
    : kinds.map((k) => gatewayForKind(k, env)).filter((g): g is PrimaryEnv => g !== null);
  const results = await Promise.all(
    candidates.map(async (gateway) => {
      const info = await primaryStatus(id, gateway);
      return info ? { info, gateway } : null;
    }),
  );
  const found = results.filter((r) => r !== null);
  // IDs numéricos podem coincidir entre gateways. Não escolher arbitrariamente.
  return found.length === 1 ? found[0]! : null;
}
