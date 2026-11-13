// Consulta de CPF (funil SuperSim) — server-side only.
// Provedores (CPF_PROVIDER):
//   amnesia (padrão) — GET {CPF_BASE_URL}/?token={CPF_API_KEY}&cpf={numeros}
//     Resposta 200 { DADOS: { cpf, nome, nome_mae, data_nascimento, sexo } }.
//     O provedor responde SEMPRE 200: erro vem como { erro: "..." } (ex.: "CPF inválido")
//     ou texto puro (ex.: token vencido) → tratado como indisponível.
//     DADOS com campos vazios = não-encontrado.
//   zipcardx — GET {CPF_BASE_URL}/consult/{numeros} com
//     header `Authorization: Bearer {CPF_API_KEY}`.
//     200 flat { CPF, NOME, SEXO, NASC, NOME_MAE }; 401 = token inválido,
//     404 = não-encontrado, 429 = excesso de consultas.
// Env vars (nunca hardcodar, nunca expor no navegador):
//   CPF_API_KEY            (token/credencial da conta — query no amnesia, Bearer no zipcardx)
//   CPF_PROVIDER           (opcional; `amnesia` | `zipcardx`; padrão `amnesia`)
//   CPF_BASE_URL           (opcional; padrão por provedor)
//   CPF_LIMITE_POR_MINUTO  (opcional, padrão 12 — rate limit por IP nesta rota)

const REQUEST_TIMEOUT_MS = 10_000;

export type CpfProvider = "amnesia" | "zipcardx";

export type CpfEnv = {
  provider: CpfProvider;
  apiKey: string;
  baseUrl: string;
  limitePorMinuto: number;
};

// Base pública de cada provedor; a credencial continua só via CPF_API_KEY.
const BASES: Record<CpfProvider, string> = {
  amnesia: "https://api.amnesiatecnologia.lat",
  zipcardx: "https://api.zipcardx.online/api/v1",
};

export function resolveCpfEnv(env?: Record<string, string | undefined>): CpfEnv {
  const e =
    env ??
    (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ??
    {};
  const limiteRaw = Number.parseInt((e["CPF_LIMITE_POR_MINUTO"] ?? "").trim(), 10);
  const pedido = (e["CPF_PROVIDER"] ?? "").trim().toLowerCase();
  const provider: CpfProvider = pedido === "zipcardx" || pedido === "amnesia" ? pedido : "amnesia";
  return {
    provider,
    apiKey: (e["CPF_API_KEY"] ?? "").trim(),
    baseUrl: (e["CPF_BASE_URL"] ?? "").trim().replace(/\/+$/, "") || BASES[provider],
    limitePorMinuto: Number.isFinite(limiteRaw) && limiteRaw > 0 ? limiteRaw : 12,
  };
}

/** Mesma validação de dígito do Bebidas-Chabas (Documento::cpfValido / checkout.js cpfValido). */
export function cpfValido(valor: unknown): boolean {
  const d = String(valor ?? "").replace(/\D/g, "");
  if (d.length !== 11) return false;
  if (/^(\d)\1{10}$/.test(d)) return false;
  const digito = (ate: number): number => {
    let soma = 0;
    for (let i = 0; i < ate; i++) soma += Number(d.charAt(i)) * (ate + 1 - i);
    const resto = (soma * 10) % 11;
    return resto === 10 ? 0 : resto;
  };
  return digito(9) === Number(d.charAt(9)) && digito(10) === Number(d.charAt(10));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function pickString(data: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = data[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

/** Normaliza YYYY-MM-DD → DD/MM/YYYY para exibição no funil. Mantém outros formatos. */
export function normalizarNascimento(valor: string): string {
  const v = valor.trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v);
  if (m) return `${m[3]}/${m[2]}/${m[1]}`;
  return v;
}

/** Mascarado p/ log (nunca logar o CPF cheio). */
export function mascararCpf(numeros: string): string {
  return numeros.length === 11 ? `${numeros.slice(0, 3)}...${numeros.slice(-2)}` : "...";
}

export type CpfConsultaOk = {
  ok: true;
  encontrado: boolean;
  nome: string;
  nomeMae: string;
  nascimento: string;
  sexo: string;
};

export type CpfConsultaFalha = {
  ok: false;
  status: "rate-limit" | "indisponivel";
  mensagem: string;
};

export async function consultarCpf(
  numeros: string,
  env: CpfEnv,
): Promise<CpfConsultaOk | CpfConsultaFalha> {
  return env.provider === "zipcardx"
    ? consultarZipcardx(numeros, env)
    : consultarAmnesia(numeros, env);
}

function naoEncontrado(): CpfConsultaOk {
  return { ok: true, encontrado: false, nome: "", nomeMae: "", nascimento: "", sexo: "" };
}

function indisponivel(): CpfConsultaFalha {
  return {
    ok: false,
    status: "indisponivel",
    mensagem: "Não foi possível consultar o CPF agora.",
  };
}

/** Corta texto de origem externa antes de logar (não logar CPF cheio nem corpo inteiro). */
function cortar(valor: string, max = 120): string {
  const t = valor.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

async function lerCorpo(res: Response): Promise<unknown> {
  let texto = "";
  try {
    texto = await res.text();
  } catch {
    return null;
  }
  try {
    return JSON.parse(texto) as unknown;
  } catch {
    // Provedor pode responder texto puro (ex.: aviso de token vencido) — devolve cru.
    return { __texto: cortar(texto) };
  }
}

/** Amnesia Tecnologia: GET {base}/?token=...&cpf=... — sempre HTTP 200. */
async function consultarAmnesia(
  numeros: string,
  env: CpfEnv,
): Promise<CpfConsultaOk | CpfConsultaFalha> {
  const url = `${env.baseUrl}/?token=${encodeURIComponent(env.apiKey)}&cpf=${encodeURIComponent(numeros)}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    console.error("[sup-cpf] falha de conexao com amnesia", mascararCpf(numeros), error);
    return indisponivel();
  }

  const corpo = await lerCorpo(res);

  if (res.status === 429) {
    return {
      ok: false,
      status: "rate-limit",
      mensagem: "Muitas consultas seguidas. Tente em instantes.",
    };
  }
  if (res.status !== 200 || !corpo || typeof corpo !== "object") {
    console.error("[sup-cpf] amnesia recusou", res.status, mascararCpf(numeros));
    return indisponivel();
  }

  const raiz = corpo as Record<string, unknown>;
  const avisoTexto = pickString(raiz, "__texto");
  if (avisoTexto) {
    console.error("[sup-cpf] amnesia resposta nao-json", mascararCpf(numeros), avisoTexto);
    return indisponivel();
  }

  const erro = pickString(raiz, "erro", "ERRO", "error");
  if (erro) {
    console.error("[sup-cpf] amnesia recusou", mascararCpf(numeros), cortar(erro));
    // Ex.: { erro: "CPF inválido" } — número recusado pelo provedor (dígito já validado aqui).
    if (/inv[aá]lid/i.test(erro)) return naoEncontrado();
    return indisponivel();
  }

  const dados = asRecord(raiz["DADOS"]) ?? asRecord(raiz["dados"]) ?? raiz;
  const nome = pickString(dados, "nome", "NOME", "Nome", "name", "NAME");
  if (!nome) return naoEncontrado();

  return {
    ok: true,
    encontrado: true,
    nome,
    nomeMae: pickString(
      dados,
      "nome_mae",
      "NOME_MAE",
      "nomeMae",
      "mae",
      "MAE",
      "nome_mae_social",
      "NOME_MAE_SOCIAL",
    ),
    nascimento: normalizarNascimento(
      pickString(
        dados,
        "data_nascimento",
        "nascimento",
        "NASC",
        "NASCIMENTO",
        "nasc",
        "data_nasc",
        "birthDate",
      ),
    ),
    sexo: pickString(dados, "sexo", "SEXO", "Sexo", "gender"),
  };
}

/** ZipCardX: GET {base}/consult/{numeros} com Bearer. */
async function consultarZipcardx(
  numeros: string,
  env: CpfEnv,
): Promise<CpfConsultaOk | CpfConsultaFalha> {
  let res: Response;
  try {
    res = await fetch(`${env.baseUrl}/consult/${numeros}`, {
      method: "GET",
      headers: { Accept: "application/json", Authorization: `Bearer ${env.apiKey}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    console.error("[sup-cpf] falha de conexao com zipcardx", mascararCpf(numeros), error);
    return indisponivel();
  }

  if (res.status === 404) return naoEncontrado();
  if (res.status === 401 || res.status === 403) {
    console.error("[sup-cpf] provedor recusou", res.status, mascararCpf(numeros));
    return indisponivel();
  }
  if (res.status === 429) {
    return {
      ok: false,
      status: "rate-limit",
      mensagem: "Muitas consultas seguidas. Tente em instantes.",
    };
  }

  const corpo = await lerCorpo(res);
  // ZipCardX responde flat { CPF, NOME, SEXO, NASC, NOME_MAE } (sem envelope).
  const interna = asRecord(corpo);
  if (res.status !== 200 || !interna || interna["success"] === false) {
    console.error("[sup-cpf] provedor recusou", res.status, mascararCpf(numeros));
    return indisponivel();
  }

  const nome = pickString(interna, "NOME", "nome", "Nome", "name", "NAME");
  const nomeMae = pickString(
    interna,
    "NOME_MAE",
    "NOME_MAE_SOCIAL",
    "MAE",
    "mae",
    "nomeMae",
    "nome_mae",
    "mother",
  );
  const nascimento = normalizarNascimento(
    pickString(interna, "NASC", "nasc", "NASCIMENTO", "nascimento", "data_nasc", "birthDate"),
  );
  const sexo = pickString(interna, "SEXO", "sexo", "gender", "Sexo");

  return {
    ok: true,
    encontrado: nome !== "",
    nome,
    nomeMae,
    nascimento,
    sexo,
  };
}

// Rate limit simples por IP (espelha CPF_LIMITE_POR_MINUTO do outro projeto).
const acessosPorIp = new Map<string, number[]>();

export function excedeuRitmo(ip: string, limitePorMinuto: number): boolean {
  if (!ip || limitePorMinuto <= 0) return false;
  const agora = Date.now();
  const lista = (acessosPorIp.get(ip) ?? []).filter((t) => agora - t < 60_000);
  if (lista.length >= limitePorMinuto) {
    acessosPorIp.set(ip, lista);
    return true;
  }
  lista.push(agora);
  acessosPorIp.set(ip, lista);
  return false;
}
