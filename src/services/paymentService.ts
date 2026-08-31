import crypto from "crypto";
import { pool } from "../db/pool";
import { env } from "../config/env";
import { getPlan } from "./planService";
import { createVoucherBatch } from "./voucherService";

const PAYSTACK_BASE = "https://api.paystack.co";

function assertConfigured() {
  if (!env.paystack.secretKey) {
    throw new Error(
      "Online payments aren't configured — set PAYSTACK_SECRET_KEY (and PAYSTACK_PUBLIC_KEY) in the backend .env",
    );
  }
}

export interface InitializedPayment {
  reference: string;
  authorizationUrl: string;
}

/**
 * Starts a Paystack Standard Checkout transaction for one plan purchase and
 * records a pending `payments` row up front, so the portal's "waiting for
 * payment" screen has a reference to poll immediately, before the customer
 * has even reached Paystack's page.
 */
export async function initializePayment(
  planKey: string,
  email: string,
  callbackUrl: string,
): Promise<InitializedPayment> {
  assertConfigured();
  const plan = await getPlan(planKey);
  if (!plan) throw new Error(`Unknown plan key: ${planKey}`);
  if (plan.priceKobo <= 0) throw new Error("This plan is not for sale online");

  const res = await fetch(`${PAYSTACK_BASE}/transaction/initialize`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.paystack.secretKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      email,
      amount: plan.priceKobo, // Paystack takes NGN amounts in kobo — same unit our column already uses
      callback_url: callbackUrl,
      metadata: { planKey: plan.key },
    }),
  });
  const data: any = await res.json();
  if (!res.ok || !data.status) {
    throw new Error(data?.message || "Paystack initialize request failed");
  }

  await pool.query(
    `INSERT INTO payments (reference, plan_key, email, amount_kobo, status)
     VALUES ($1, $2, $3, $4, 'pending')`,
    [data.data.reference, plan.key, email, plan.priceKobo],
  );

  return { reference: data.data.reference, authorizationUrl: data.data.authorization_url };
}

/**
 * Verifies the raw webhook body against Paystack's `x-paystack-signature`
 * header (HMAC-SHA512 of the exact request bytes, keyed with the secret
 * key). Must run against the untouched raw body, not a re-serialized JSON
 * object — see index.ts's express.json({ verify }) hook, which stashes it
 * on req.rawBody for this exact purpose.
 */
export function verifyWebhookSignature(rawBody: Buffer | undefined, signature: string | undefined): boolean {
  if (!rawBody || !signature || !env.paystack.secretKey) return false;
  const hash = crypto.createHmac("sha512", env.paystack.secretKey).update(rawBody).digest("hex");
  return hash === signature;
}

export interface PaymentStatus {
  reference: string;
  status: string;
  planKey: string;
  voucherPin: string | null;
}

export async function getPaymentStatus(reference: string): Promise<PaymentStatus | null> {
  const { rows } = await pool.query(
    "SELECT reference, status, plan_key, voucher_pin FROM payments WHERE reference = $1",
    [reference],
  );
  if (!rows.length) return null;
  const r = rows[0];
  return { reference: r.reference, status: r.status, planKey: r.plan_key, voucherPin: r.voucher_pin };
}

/**
 * Called from the webhook handler on charge.success. Idempotent by design —
 * Paystack retries webhooks that don't 200 quickly, and can occasionally
 * double-send even after a 200, so a reference that's already fulfilled
 * (has a voucher_pin) is a no-op rather than issuing a second voucher.
 */
export async function fulfillPayment(reference: string): Promise<void> {
  const { rows } = await pool.query("SELECT * FROM payments WHERE reference = $1", [reference]);
  if (!rows.length) {
    console.warn(`[paymentService] webhook for unknown reference: ${reference}`);
    return;
  }
  const payment = rows[0];
  if (payment.voucher_pin) return; // already fulfilled

  const [voucher] = await createVoucherBatch(payment.plan_key, 1);

  await pool.query(
    `UPDATE payments SET status = 'success', voucher_pin = $1, verified_at = now() WHERE reference = $2`,
    [voucher.pin, reference],
  );
}

export async function markPaymentFailed(reference: string): Promise<void> {
  await pool.query(
    `UPDATE payments SET status = 'failed' WHERE reference = $1 AND status = 'pending'`,
    [reference],
  );
}

export interface PaymentLookupResult {
  reference: string;
  planKey: string;
  planLabel: string;
  voucherPin: string;
  createdAt: string;
  expiresAt: string | null;
  disabled: boolean | null;
}

/**
 * Backs the portal's "Recover my voucher" page (PortalRecover.tsx) — the
 * fallback for losing PortalBuyComplete's page before copying the PIN down,
 * since there's no SMS/email delivery in this build. Matched on email only
 * (the one thing PortalBuy actually collects, not a phone number), most
 * recent first, capped at 10.
 *
 * Deliberately NOT verified beyond "knows the email" — same trust model as
 * the rest of /api/payments and /api/portal (the PIN itself is the real
 * credential, same as the router's own hotspot login). Someone who knows a
 * stranger's email could recover their still-valid vouchers this way; for
 * this app's scale (one operator, one router) that's an accepted trade-off
 * rather than building out email verification, but worth knowing if this
 * ever needs to be hardened.
 */
export async function lookupPaymentsByEmail(email: string): Promise<PaymentLookupResult[]> {
  const { rows } = await pool.query(
    `SELECT p.reference, p.plan_key, pl.label AS plan_label, p.voucher_pin, p.created_at,
            v.expires_at, v.disabled
     FROM payments p
     JOIN plans pl ON pl.key = p.plan_key
     LEFT JOIN vouchers v ON v.pin = p.voucher_pin
     WHERE lower(p.email) = lower($1) AND p.status = 'success' AND p.voucher_pin IS NOT NULL
     ORDER BY p.created_at DESC
     LIMIT 10`,
    [email],
  );
  return rows.map((r) => ({
    reference: r.reference,
    planKey: r.plan_key,
    planLabel: r.plan_label,
    voucherPin: r.voucher_pin,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    disabled: r.disabled,
  }));
}
