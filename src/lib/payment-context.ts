// Contexto de conciliação criptografado. Não é banco nem chave de idempotência.
// Permite que o webhook recupere a venda mesmo com o navegador fechado.
import { z } from "zod";
import type { VendaSup } from "./utmify.ts";

const schema = z.object({
  version: z.literal(1),
  expires: z.number(),
  reference: z.string().min(8).max(80),
  createdAt: z.string().regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/),
  customer: z.object({
    name: z.string().max(200),
    email: z.string().max(200),
    phone: z.string().max(20),
    document: z.string().max(20),
    ip: z.string().max(100).optional(),
  }),
  product: z.object({
    id: z.string().max(160),
    name: z.string().max(300),
    priceInCents: z.number().int().positive(),
  }),
  tracking: z.record(z.string(), z.string().max(180).nullable()).optional(),
});

export type PaymentContext = z.infer<typeof schema>;

function encode(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function decode(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
}

async function key(secret: string): Promise<CryptoKey> {
  if (secret.length < 32) throw new Error("Segredo de contexto ausente/inválido");
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", hash, "AES-GCM", false, ["encrypt", "decrypt"]);
}

const aad = new TextEncoder().encode("sup-payment-context-v1");

export async function sealPaymentContext(
  input: Omit<PaymentContext, "version" | "expires">,
  secret: string,
): Promise<string> {
  const context = schema.parse({ ...input, version: 1, expires: Date.now() + 7 * 86400_000 });
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: aad },
    await key(secret),
    new TextEncoder().encode(JSON.stringify(context)),
  );
  return `${encode(iv)}.${encode(new Uint8Array(encrypted))}`;
}

export async function openPaymentContext(
  token: string,
  secret: string,
): Promise<PaymentContext | null> {
  try {
    if (token.length > 8000 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) return null;
    const [iv, ciphertext] = token.split(".");
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: decode(iv!), additionalData: aad },
      await key(secret),
      decode(ciphertext!),
    );
    const context = schema.parse(JSON.parse(new TextDecoder().decode(plain)));
    return context.expires > Date.now() ? context : null;
  } catch {
    return null;
  }
}

export function contextVenda(context: PaymentContext, id: string, paidAt: string): VendaSup {
  return {
    orderId: id,
    status: "paid",
    createdAt: context.createdAt,
    approvedDate: paidAt,
    customer: {
      name: context.customer.name,
      email: context.customer.email,
      phone: context.customer.phone,
      document: context.customer.document,
      ...(context.customer.ip ? { ip: context.customer.ip } : {}),
    },
    product: context.product,
    ...(context.tracking ? { tracking: context.tracking } : {}),
  };
}
