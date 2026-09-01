import crypto from "crypto";
import { describe, it, expect } from "vitest";
import { env } from "../src/config/env";
import { verifyWebhookSignature } from "../src/services/paymentService";

// Requires PAYSTACK_SECRET_KEY to be set in .env — same requirement the
// real webhook route has (see routes/payments.ts). If it's blank, these
// skip rather than fail, matching the app's own "payments disabled, rest
// of the app works unaffected" behavior.
const hasSecret = !!env.paystack.secretKey;
const describeIfConfigured = hasSecret ? describe : describe.skip;

function sign(body: Buffer): string {
  return crypto.createHmac("sha512", env.paystack.secretKey).update(body).digest("hex");
}

describeIfConfigured("paymentService.verifyWebhookSignature", () => {
  const body = Buffer.from(JSON.stringify({ event: "charge.success", data: { reference: "test-ref-123" } }));

  it("accepts a correctly-signed body", () => {
    expect(verifyWebhookSignature(body, sign(body))).toBe(true);
  });

  it("rejects a signature computed over different bytes (e.g. a re-serialized body)", () => {
    const tamperedBody = Buffer.from(JSON.stringify({ event: "charge.success", data: { reference: "different-ref" } }));
    expect(verifyWebhookSignature(tamperedBody, sign(body))).toBe(false);
  });

  it("rejects a garbage signature", () => {
    expect(verifyWebhookSignature(body, "not-a-real-signature")).toBe(false);
  });

  it("rejects a missing signature", () => {
    expect(verifyWebhookSignature(body, undefined)).toBe(false);
  });

  it("rejects a missing body", () => {
    expect(verifyWebhookSignature(undefined, sign(body))).toBe(false);
  });
});

describe.skipIf(hasSecret)("paymentService.verifyWebhookSignature (PAYSTACK_SECRET_KEY not set)", () => {
  it("always rejects when Paystack isn't configured", () => {
    const body = Buffer.from("{}");
    expect(verifyWebhookSignature(body, "anything")).toBe(false);
  });
});
