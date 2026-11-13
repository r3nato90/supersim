# Auditoria de duplicação PIX — 21/10/2026

## Correção do fluxo após a auditoria

O código atual mitiga as lacunas abaixo com referência server-side HMAC estável
por documento/produto/valor/conta, single-flight/replay na mesma instância e cache
v3 por documento/produto no navegador (sem e-mail). Referências inválidas são
recusadas, não substituídas por IDs aleatórios. Nome/contato não mudam a chave.

Reabertura de estado desconhecido usa `recoverOnly` e nunca cria um novo PIX
quando não há resposta na instância. QR vencido não ganha validade fictícia;
renovação requer consulta autenticada confirmando `expired`, vínculo com a compra
e valor correto. Pago, pendente ou consulta indisponível não autoriza renovação.
Web Locks é obrigatório para iniciar/renovar. Migração v2 ambígua falha fechada.

**Limite não resolvido:** o bug interno da Velani não foi alterado. Single-flight
é memória por instância, não um lock distribuído. Duas instâncias independentes
ainda podem criar duas cobranças se o gateway não deduplicar. Há teste explícito
desse limite. Sem banco/Redis, não há como prometer garantia global.

O replay retém até 2000 entradas por 7 dias; lotado recusa novas criações, sem
expulsar operações em andamento ou resultados desconhecidos. Cold starts,
retenção vencida e rotação da API key perdem essa proteção. A chave da conta é a
chave HMAC: rotação também altera a referência canônica. Conciliar pendências
antes de rotacionar; não considerar esse cache um registro permanente.

## Resultado principal da auditoria anterior à correção do fluxo

Com autorização para testes pendentes, foram feitas **duas chamadas concorrentes**
ao adapter `primaryCreate`, com o mesmo payload, referência e valor de **R$5,00**.
O adapter atual deriva a mesma `x-idempotency-key` desses dados nas duas chamadas.

Ambas responderam HTTP 200, mas com **IDs diferentes**. Consultas GET posteriores
confirmaram que as duas transações tinham a mesma referência de teste, valor de
500 centavos, status `pending` e `paid: false`.

- Dados exclusivamente sintéticos, sem CPF/telefone de cliente.
- Descrição: `TESTE TECNICO - NAO PAGAR`.
- Nenhum pagamento, estorno ou cancelamento foi executado.
- Sem callback por transação e sem chamar a rota de criação/UTMify/CAPI do projeto.
  Integrações globais da conta do gateway não foram inspecionadas nem alteradas.
- IDs e referência completos estão na sessão de diagnóstico; não é necessário
  versionar identificadores da conta ou credenciais.
- Não foram feitas novas criações após constatar a duplicação; apenas consultas GET.

Isso comprova que **a proteção atual não impediu a duplicação concorrente no
teste real**. Não determina se o provedor ignora a chave em geral ou se existe
uma corrida específica na implementação. Retenção e repetição sequencial da
chave não foram validadas nesse teste. Encaminhar a evidência ao suporte Velani.

## Lacunas locais reproduzidas antes da correção

1. **Referência nova = chave nova:** a mesma compra pode gerar outros pendentes
   após limpar storage, trocar de navegador/origem ou alterar o e-mail.
2. **Identidade mutável na chave:** mesmo mantendo `clientOrderId`, mudar nome,
   e-mail (inclusive caixa) ou telefone altera o hash enviado à Velani.
3. **Referência ausente/inválida:** a rota aceita ausência, vazio ou formato curto
   e gera outra referência aleatória a cada requisição.
4. **Sem coordenação no servidor:** 25 chamadas idênticas ao handler produzem
   25 POSTs ao gateway. Só há um ID se o provedor simulado deduplicar. Se ele não
   deduplicar, o handler aceita os IDs distintos, como observado no teste real.
5. **Corrida sem Web Locks:** modelo com três threads força três leituras do
   storage antes da primeira gravação e reproduz três POSTs. Não é um teste de
   abas de um navegador real; o modelo de exclusão mútua também é simulado.
6. **QR expirado em cache:** o navegador não verifica `expiresAt` no reuso e volta
   a exibir o QR com timer de 900 segundos. O timer também encerra o polling após
   15 minutos independentemente da validade informada pelo gateway.
7. **Criação desconhecida sem recuperação:** timeout ou falha ao salvar a
   resposta deixa `pending` local bloqueado, sem consultar/converter esse estado
   na reabertura. Isso evita retry perigoso, mas pode travar o checkout.
8. **Normalização divergente:** espaços no e-mail criam outra identidade local,
   embora a rota remova os espaços. Maiúsculas são normalizadas no cache local,
   mas não na chave gerada no servidor.

## Proteções que funcionaram nos testes locais

- 100 cliques simultâneos na mesma página: um POST de criação.
- 20 fechamentos/reaberturas com storage preservado: um POST.
- Recarregar preservando storage: reaproveita o PIX.
- Abas com Web Locks e storage compartilhados no modelo: um POST.
- Polling de pendência: somente consultas; não cria PIX nem confirma venda.
- Status pago consultado: interrompe polling, sem criar outro PIX.
- HTTP 400/401/422/424/429/500/503 e timeout: sem retry automático na Velani.
- Storage indisponível ou JSON corrompido: falha fechada, sem nova cobrança.

## Como reproduzir localmente

```powershell
node --test "src/lib/*.test.mjs"
```

Arquivos específicos:

- `src/lib/velani-duplicates.test.mjs`: cache real do navegador + adapter real,
  com HTTP e transporte da rota simulados.
- `src/lib/sup-pix-duplicates.test.mjs`: handler POST real transpilado em memória,
  adapter real, gateway e serviços externos simulados. Não inicia o servidor HTTP.
- `src/lib/pix-browser-lifecycle.test.mjs`: funções reais de modal, cache, timer e
  polling com DOM/storage/relógio/HTTP simulados, além do modelo concorrente.

Os testes foram atualizados para exigir um único POST na mesma instância, inclusive
quando o gateway simulado ignora a chave. O teste **LIMITE DISTRIBUÍDO** confirma
o risco residual entre instâncias. A suíte local não acessa credenciais, não faz
chamadas reais e não valida o deploy de produção.

## Prioridade de correção

- Levar a duplicação com a mesma referência/chave ao suporte do gateway.
- Estabilizar a identidade da compra e não substituir referência inválida por
  outra silenciosamente. Separar retries da mesma compra de novas compras.
- Para impedir concorrência entre instâncias, é necessário recurso atômico do
  provedor ou armazenamento compartilhado. Locks/cache em memória de uma única
  instância não oferecem essa garantia na Vercel. O projeto continua sem banco
  ou Redis, conforme a decisão existente; nada disso foi introduzido na auditoria.
- Validar expiração real e oferecer conciliação segura do estado desconhecido,
  sem recriar automaticamente uma cobrança que talvez já exista.

A correção posterior à auditoria altera o fluxo local e server-side. Nenhuma
alteração foi feita nos servidores da Velani, nem foi realizado deploy automático.
