# Welcome to your Lovable project

This project was built with [Lovable](https://lovable.dev).

## Build with Lovable

Open your project in the [Lovable editor](https://lovable.dev) and keep building.

- **Ship faster**: describe what you want to build and Lovable handles the code.
- **Stay in sync**: connect the project to GitHub and every change made in Lovable is committed straight to your repository.
- **Full ownership**: this code is yours. Push to your repository and your changes sync back into Lovable, ready for your next prompt.

## Development

Prefer working locally? You need Node.js and npm — [install with nvm](https://github.com/nvm-sh/nvm#installing-and-updating).

```sh
git clone <this-repository-url>
cd <repository-name>
npm i
npm run dev
```

## Built with

- TanStack Start
- TypeScript
- React
- Tailwind CSS

## Tracking central
1. API central: https://adroute-five.vercel.app
2. Variável: `VITE_TRACKING_API_URL` (sem `/admin`). As páginas do funil usam `/tracking.js`, que já tem essa URL como padrão.
3. O domínio é detectado automaticamente (`window.location.hostname`), então funciona em remixes.
4. Não precisa de Conversion ID/Label aqui.
5. Não configurar nenhum segredo neste projeto (nem PIX_WEBHOOK_SECRET nem PIX_CENTRAL_WEBHOOK_SECRET).
7. O webhook de pagamento é configurado no painel do gateway (ou via `PIX_GATEWAY_POSTBACK_URL`), apontando para https://SEU-DOMINIO/api/public/sup-webhook.
8. A compra só é confirmada pela API central depois desse webhook; o frontend envia apenas sessão, lead e pedido PENDING.
6. Integração global: `public/tracking.js` + `GlobalTracking` no layout raiz.
