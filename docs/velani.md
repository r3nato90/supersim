# Velani — troca do gateway PIX

Configuração exclusivamente server-side (nunca versionar chaves):

```dotenv
PIX_GATEWAY=velani
PIX_GATEWAY_API_KEY=<Secret Key sk_live_...>
PIX_GATEWAY_WEBHOOK_SECRET=<segredo do webhook Velani whsec_...>
PIX_GATEWAY_MIN_AMOUNT_CENTS=500
```

- Limpar `PIX_GATEWAY_CREATE_URL` e `PIX_GATEWAY_STATUS_URL` antigos. O adapter usa
  `https://api.velanipagamentos.com.br/api/v1/api-gateway/v1/transactions`.
  Overrides Velani fora do host oficial ou sem HTTPS desativam a integração.
- `PIX_GATEWAY_POSTBACK_URL` pode ficar vazio em produção: a rota monta o callback
  HTTPS `/api/public/sup-webhook?gateway=velani` na origem da requisição. Em ambiente
  local HTTP, configurar uma URL HTTPS acessível pela Velani.
- A chave pública não cria cobranças e não é necessária neste fluxo.
- Preservar credenciais antigas em `PIX_GATEWAY_{KIND}_API_KEY` e os respectivos
  overrides/segredos. Não substituir um segredo antigo pelo da Velani.
- A troca local não atualiza a Vercel: atualizar as mesmas variáveis no ambiente
  de destino e fazer novo deploy. Nenhum deploy é feito automaticamente.

## Proteções e pendências

- Valor em centavos; piso conservador de R$5 por histórico da integração, embora
  a documentação anuncie R$1. Não houve teste de cobrança real na nova conta.
- Criação usa `x-api-key` e `x-idempotency-key` derivado da referência/valor/método da
  compra, sem nome ou contato. Repetições preservam a chave; timeout/5xx não repetem o POST
  automaticamente. A documentação não especifica o prazo de retenção da chave.
- **Auditoria real em 21/10/2026:** duas criações concorrentes idênticas pelo
  adapter retornaram dois PIX pendentes de R$5 com a mesma referência. A chave
  atual não impediu essa duplicação; não tratar o header como garantia global.
  Evidências, limitações e reprodução local em [pix-duplicacao-testes.md](pix-duplicacao-testes.md).
- Mitigação no fluxo: referência server-side HMAC por documento/produto/valor/conta,
  single-flight e replay por instância (7 dias, até 2000 compras; lotado recusa novas
  criações sem expulsar pendências). Preserva ID e `createdAt`. `recoverOnly` nunca
  inicia cobrança se a resposta não estiver nesta instância. Isso **não** é lock
  distribuído: cold starts, outras instâncias, perda do storage e rotação da chave
  da conta ainda exigem idempotência real do gateway ou persistência compartilhada.
- Navegador usa cache v3 por documento/produto, sem e-mail. Migra QR/pendência v2
  quando identificável; legado ambíguo bloqueia criação e pede suporte. Novas
  cobranças/renovações exigem Web Locks; navegador sem suporte só reutiliza ou
  recupera uma compra existente. Não usar fallback com locks de localStorage.
- Validade usa `expiresAt`. Um PIX expirado não é exibido como novo; renovação
  exige GET autenticado confirmando `expired`, referência da mesma compra e valor
  igual. Cada renovação é vinculada ao ID anterior; pago/pendente/incerto não renova.
- `clientOrderId` ausente/inválido agora retorna 422, sem gerar referência aleatória.
  O cliente não pode escolher outra compra alterando esse ID.
- Telefones brasileiros são normalizados para DDD+número; inválidos são omitidos
  porque o campo é opcional. CPF/CNPJ enviado sem máscara.
- Somente status `paid` consultado na API confirma o pagamento. Outros status
  não liberam acesso mesmo com flag ou data de pagamento contraditória.
- Webhook assinado com HMAC-SHA256 hexadecimal de `JSON.stringify(data)`.
  Configurar o segredo real no painel e no servidor; não inventar nem reutilizar
  o segredo de outro gateway. Sem segredo, o comportamento legado é confirmar
  apenas via API, sem autenticação HMAC do remetente.
- Falhas temporárias na consulta/CAPI retornam 503 para pedir reentrega. A Velani
  documenta somente três reentregas (30s, 2min, 10min); não há fila própria.
- UTMify: o fluxo existente envia `waiting_payment` no servidor e atualiza `paid`
  via navegador, sempre revalidando no gateway. Diferentemente do Pague-X, a
  Velani não utiliza o contexto criptografado para UTMify após fechar a aba.
  Verificar se a integração UTMify do painel Velani está ativa para evitar dois
  emissores com IDs diferentes. Nenhuma configuração do painel foi alterada.

Documentação: https://velanipagamentos.com.br/docs/api/
