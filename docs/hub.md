# Hub de gateways (Gatehub)

Uma única API de pagamentos: o projeto fala só com o hub e ele escolhe a
gateway real (Beehive, Velani, Pingu, Pague-X ou FreePay). Trocar de gateway
passa a ser uma ação no painel, sem alterar código nem fazer deploy.

- API: `https://hub-de-gateways.vercel.app` (sobrescrevível por `HUB_URL`)
- Doc oficial: `/docs.md`, contrato `openapi.json`, índice `llms.txt`
- Chave e segredo são **server-side only** (nunca no navegador)

## Variáveis de ambiente

| Variável | Obrigatória | Para que serve |
|---|---|---|
| `HUB_URL` | não | URL do hub, sem barra final. Padrão no código: `https://hub-de-gateways.vercel.app` |
| `HUB_API_KEY` | sim | Chave `hub_live_...`. Define o cliente. **Ativa o adapter `hub`** quando `PIX_GATEWAY` está vazio |
| `HUB_WEBHOOK_SECRET` | sim, p/ webhook | Segredo `whs_...` que assina o `x-hub-signature`. Sem ele o webhook é recusado com 503 |
| `HUB_SLUG` | não | Nome do funil no painel (aba *Funis*). Define qual gateway cobra esta loja; vazio = gateway ativa do hub |

`PIX_GATEWAY=hub` também seleciona o hub explicitamente. A escolha explícita
sempre vence: para voltar a uma gateway direta basta definir
`PIX_GATEWAY=beehive` (ou `velani`, `paguex`, ...) e a chave correspondente —
as credenciais antigas continuam valendo para consultar cobranças históricas
(`PIX_GATEWAY_<KIND>_API_KEY`).

> O hub **não** usa `PIX_GATEWAY_API_KEY`: essa variável é da gateway direta.
> Também não há `Idempotency-Key`/webhook por cobrança — o webhook é o
> cadastrado no painel do hub.

## Como o funil usa o hub

`src/lib/pay-gateway.ts` (kind `hub`):

1. **Criar** — `POST {HUB_URL}/api/v1/charges` com `Bearer HUB_API_KEY`.
   `amount` em centavos, `method: "pix"`, `customer.{name,email,document,phone}`
   (documento só números; telefone em E.164), `ip` do comprador (obrigatório na
   Beehive), `reference` = referência do pedido, `funnel` (`HUB_SLUG`),
   `shopUrl`/`checkoutUrl` da página e `items`/`tracking` (só relatório).
   A criação manda `Idempotency-Key: <reference>`: repetir em até 24 h devolve a
   **mesma** cobrança em vez de criar outra.
2. **Consultar** — `GET {HUB_URL}/api/v1/charges/{id}`. O id do hub é
   `<gateway>_<idExterno>` (`velani_8f2a1c`), então ele **não** é o mesmo id da
   gateway de trás; guardar o id do hub é obrigatório.
3. **Webhook** — o hub faz `POST` com
   `{ event: "charge.updated", charge: { id, gateway, status, amount, method, reference } }`
   e `x-hub-signature` (`"sha256="` + HMAC-SHA256 hex do corpo bruto).
   A rota `src/routes/api/public/sup-webhook.ts` valida a assinatura
   (`HUB_WEBHOOK_SECRET`) e `src/lib/hub-webhook.ts` **reconsulta a API** antes
   de disparar a Purchase da Meta (o hub já confirmou, mas a API é a fonte da
   verdade). `2xx` = processado; `503` = o hub reenfileira sozinho; `422` =
   valor divergente (não dispara venda).

## Diferenças que mudam comportamento

- **Status**: o hub só usa `pending`, `paid`, `failed`, `canceled`, `refunded`,
  `chargeback`. Não existe `expired`: um Pix vencido chega como `failed`/
  `canceled`. Por isso `sup-status` devolve `renewable: true` quando a cobrança
  não pode mais ser paga (`primaryUnpayable`) e o navegador renova por esse
  campo — comparar o texto `"expired"` (gateways diretas) continua valendo.
- **QR**: `pix.copyPaste` vem sempre; `pix.qrCode` é a imagem e pode vir vazio
  (Beehive, Pingu, FreePay). O funil usa o copia-e-cola e desenha o QR no
  navegador.
- **Expiração**: só vem quando a gateway informa. Na Pingu `expiresAt` = `null`;
  o modal mostra "⏳ Aguardando confirmação" e continua consultando o status. O
  QR salvo no navegador não é renovado sozinho — renovar exige a API confirmar
  que o anterior não pode mais ser pago.
- **Mínimo**: depende da gateway ativa no painel (Pingu R$ 1,00, Velani R$ 5,00).
  O piso local do adapter é 0; a rota já recusa valor abaixo de R$ 5,00 e o
  catálogo começa em R$ 10,00.
- **Documento/telefone**: obrigatórios conforme a gateway de trás (Pingu exige
  os dois). O funil já exige CPF válido, e-mail e telefone; o telefone vai no
  formato do contrato do hub (`11999999999`, DDD + número, sem `+55`).
- **Erros**: `401` chave inválida, `422` recusa (mínimo/método/dado faltando),
  `502` gateway não respondeu (pode repetir), `503` gateway ativa sem API key no
  painel do hub.

## Checklist ao trocar de gateway no painel

1. Painel do hub (`HUB_URL/login`, login com a `HUB_API_KEY`): colar a API key
   da gateway, escolher a gateway ativa (ou o funil em *Funis*), salvar.
2. Em *Webhook do cliente*: `https://SEU-DOMINIO/api/public/sup-webhook` e usar
   **Testar agora** (o teste chega como `event: "webhook.test"` e é ignorado).
3. Na Vercel: `HUB_URL`, `HUB_API_KEY`, `HUB_WEBHOOK_SECRET`, `HUB_SLUG` e
   `PIX_GATEWAY=hub` (ou remover `PIX_GATEWAY`). Redeploy.
4. Testar um Pix real de valor baixo: QR aparece, `sup-status` confirma e a
   venda entra paga no painel do hub.

## Deploy

- O deploy do Vercel (`gabztoo/funil-supersim`) usa o commit da branch `main`.
  **O autor do commit precisa ser uma conta GitHub não bloqueada**: o
  `.gitconfig-gitcloak` deste ambiente define `user.name/user.email = macae092`,
  e commit assim volta `The Personal Account of the commit author is blocked`
  ao criar o deployment. Neste repositório o autor correto está fixado no
  config local (`git config --local user.name gabztoo` / `user.email
  anam7615@gmail.com`).
- Variáveis na Vercel (Production): `HUB_URL`, `HUB_API_KEY`,
  `HUB_WEBHOOK_SECRET`, `HUB_SLUG` e `PIX_GATEWAY=hub` (ou sem `PIX_GATEWAY`).
  Depois de salvar, **redeploy** — env de produção só entra em build novo.
- Webhook do cliente no painel do hub:
  `https://funil-supersim.vercel.app/api/public/sup-webhook`.

## Riscos conhecidos

- **Sem banco** (decisão do projeto): o id do hub só existe no `localStorage` do
  navegador e no painel do hub. Um Pix pago sem retorno (webhook perdido) ainda
  se recupera consultando `GET /api/v1/charges/{id}`, mas o funil precisa do id
  salvo no navegador.
- A `reference` fica travada 24 h no hub; renovar um Pix exige referência nova
  (o funil já usa o sufixo `_<hmac>` ao renovar).
- O hub é um terceiro no caminho do pagamento: queda dele = `502` no checkout.
  `sup-status` continua consultando pelas credenciais históricas quando o
  gateway do hint for outro.
- Gateway ativa em 05/11/2026: **Pingu** (mínimo R$ 1,00, `pix` apenas, exige
  documento e telefone, não devolve `expiresAt`). Confirmado com um Pix real de
  R$ 10,00: `POST` devolveu `id: "pingu_PINZ1D3UCPM"`, `pix.copyPaste` preenchido
  e `pix.qrCode` vazio; repetir com o mesmo `Idempotency-Key` devolveu a mesma
  cobrança com `x-idempotent-replay: 1`; `sup-status` confirmou `pending`. Esse
  teste ficou como cobrança pendente no painel do hub e como pedido
  `waiting_payment` na UTMify (não conta como venda paga).
