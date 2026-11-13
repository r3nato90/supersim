# FreePay fallback design

## Goal

Restore FreePay as a secondary PIX gateway while keeping Vexigate as the primary gateway. Both providers' credentials remain server-side environment variables.

## Creation flow

1. Use Vexigate first when configured and when the amount meets its locally configured minimum.
2. Use FreePay if Vexigate returns a definitive HTTP rejection (including 4xx such as 403/422), or if the amount is below Vexigate's minimum.
3. Do not retry on FreePay after a timeout, network failure, 5xx response, or ambiguous successful response. The first gateway may have created a charge even when its response was lost; retrying could create a duplicate.
4. If neither provider can create the charge, return an error without fabricating a QR code.
5. Preserve the existing client response shape (`txnId`, `qrcode`, `amount`, etc.) and indicate which provider created the charge.

## Status and webhook

- Status polling attempts the primary provider and then FreePay, allowing the current browser poller (which sends only a transaction ID) to confirm charges created by either provider.
- The webhook accepts both providers. Vexigate signatures are checked with `PIX_GATEWAY_WEBHOOK_SECRET`; FreePay events are confirmed against FreePay's server-side transaction-info API before emitting Purchase.
- A non-paid status must never be treated as a confirmed Purchase.

## Environment variables

- Keep `PIX_GATEWAY_API_KEY` and the existing `PIX_GATEWAY_*` variables for the primary gateway.
- Restore server-only `FREEPAY_PUBLIC_KEY`, `FREEPAY_SECRET_KEY`, and optional `FREEPAY_POSTBACK_URL` as fallback credentials/configuration.
- Never commit or expose credential values.

## Verification

- Verify definitive primary rejection (e.g. 403) falls back to FreePay and returns the FreePay transaction.
- Verify timeout, network failure, and 5xx do not invoke FreePay.
- Verify status and webhook confirmation work for both providers.
- Run TypeScript, ESLint, and production build.
