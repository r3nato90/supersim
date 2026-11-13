# Pague-X — PIX

Contrato: https://app.pague-x.com.br/docs

Configurar no servidor/Vercel (nunca com prefixo `VITE_`):

```dotenv
PIX_GATEWAY=paguex
PIX_GATEWAY_API_KEY=<secret key da conta>
PIX_GATEWAY_WEBHOOK_SECRET=<webhook secret da conta>
PIX_GATEWAY_POSTBACK_URL=https://SEU-DOMINIO/api/public/sup-webhook
PIX_GATEWAY_CREATE_URL=
PIX_GATEWAY_STATUS_URL=
PIX_GATEWAY_MIN_AMOUNT_CENTS=0
```

Remova overrides de URL/mínimo do gateway anterior. A public key não é necessária para PIX. As credenciais locais ficam em `.env.local`, ignorado pelo Git; isso não configura a Vercel.

O webhook exige `x-paguex-signature` (HMAC-SHA256 do corpo bruto). Somente `sale.paid` é candidato a Purchase, sempre revalidado via GET autenticado. Status `authorized` e `under_review` não liberam pagamento, mesmo com data de pagamento antiga.

## Implementação sem banco/Redis (Vercel)

### UTMify sem depender do navegador

Novas cobranças Pague-X recebem automaticamente um `postbackUrl` com `gateway=paguex` e um contexto `ctx`, criptografado com AES-GCM e válido por 7 dias. O contexto contém referência, cliente, produto, preço, UTMs e o mesmo `createdAt` da criação. Nenhuma credencial de API é incluída; CPF e e-mail não aparecem em texto na URL.

Após validar o HMAC, o webhook confirma via GET que a transação está paga e que referência/valor correspondem ao contexto. Envia o status `paid` à UTMify com o mesmo ID/createdAt, mesmo que o comprador tenha fechado a página. Falhas de consulta, UTMify ou Meta retornam 503 em vez de confirmar processamento inexistente. Reentregas usam os mesmos IDs (atualização na UTMify e deduplicação na Meta).

`PIX_PAYMENT_CONTEXT_SECRET` permite usar um segredo independente (32+ caracteres aleatórios). Se vazio, usa `PIX_GATEWAY_WEBHOOK_SECRET`. Preserve o segredo até expirarem os contextos existentes, inclusive ao trocar de gateway. Não registre URLs com `ctx` em logs/analytics: o token é opaco, mas contém dados criptografados.

Requisitos: `UTMIFY_API_TOKEN` configurado e Pague-X preservando o `postbackUrl` completo. Homologar isso na conta antes de produção. Cobranças anteriores, sem contexto, não têm produto/UTMs/createdAt reconstruídos automaticamente; nelas permanece o caminho antigo pelo navegador. Webhooks do painel sem `ctx` continuam compatíveis com CAPI, mas não substituem o postback contextual da cobrança.

### Cobranças de gateways anteriores

O navegador guarda o gateway junto do PIX; status e UTMify consultam esse gateway usando apenas credenciais do servidor. Mantenha as chaves antigas em variáveis próprias, por exemplo:

```dotenv
PIX_GATEWAY_BEEHIVE_API_KEY=<secret key anterior>
PIX_GATEWAY_BEEHIVE_WEBHOOK_SECRET=<se aplicável>
```

Também existem `PIX_GATEWAY_{KIND}_CREATE_URL`, `_STATUS_URL`, `_POSTBACK_URL` e `_MIN_AMOUNT_CENTS`, com KIND em maiúsculas. Sem override histórico, usa as URLs nativas, nunca as do gateway ativo. Não colocar essas variáveis no frontend.

Para páginas antigas sem gateway informado, o servidor procura nos gateways configurados. Se houver IDs coincidentes em dois gateways, recusa a confirmação em vez de escolher arbitrariamente. Sem as credenciais anteriores não há como consultar uma cobrança antiga. Para webhooks antigos, manter a URL no provedor anterior e acrescentar `?gateway=beehive` (ou o gateway correspondente) quando não houver header/evento identificável.

### Mitigação de duplicidade no navegador

O navegador persiste a referência **antes** do POST. O cache v3 usa documento/produto, sem e-mail. Reabrir o modal/F5 reaproveita a resposta PIX salva. Uma tentativa desconhecida só solicita `recoverOnly`: recupera uma resposta guardada na mesma instância do servidor ou mantém o bloqueio para suporte, sem iniciar outro POST no gateway. Apenas erros de validação local antes da criação liberam correção. Novas criações e renovações exigem Web Locks; sem suporte, o navegador falha fechado para essas operações.

Essa proteção muda a experiência: não limpar uma pendência desconhecida para tentar novamente. QRs expirados só são renovados depois de GET autenticado confirmar `expired`, referência da mesma compra e valor igual. QRs legados sem referência reconhecível exigem suporte. O cache não é um histórico de pedidos e não substitui a consulta autenticada para confirmar pagamento. O single-flight/replay no servidor dura até 7 dias, com limite de 2000 entradas por instância; não oferece persistência ou coordenação distribuída.

## Limites que não podem ser eliminados sem persistência

- **Não há idempotência distribuída:** limpar o armazenamento, trocar de aparelho, mudar de instância/cold start, rotacionar a chave da conta ou chamar a API diretamente ainda pode gerar cobranças diferentes. Navegadores sem Web Locks agora bloqueiam novas criações. A Pague-X não documenta chave de idempotência nem consulta por referência. Garantia global exige recurso do gateway ou armazenamento persistente — ambos fora da configuração escolhida.
- **Não há fila própria:** 503 solicita reentrega, mas depende da política do provedor e/ou reenvio manual pelo painel. Sem reentrega não há recuperação automática. Não há garantia de processamento exatamente uma vez; use os mesmos IDs na atualização/deduplicação.
- **Eventos fora de ordem:** o envio inicial `waiting_payment` e o webhook `paid` não têm ordenação distribuída garantida. A confirmação paga pelo navegador permanece como redundância. Uma fila/registro persistente seria necessário para controle completo de sequência.
- **Sigilo:** nenhuma informação é enviada a um novo serviço de armazenamento. O contexto criptografado viaja apenas no postback do gateway já integrado e é usado no servidor para enviar a venda à UTMify já configurada.

Validação automatizada usa mocks: não cria cobranças reais nem comprova habilitação da conta/adquirente. Para homologação, gerar uma cobrança com dados reais autorizados e conferir assinatura, consulta e pagamento ponta a ponta.
