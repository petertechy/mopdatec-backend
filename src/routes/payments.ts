import { Router } from "express";
import { z } from "zod";
import {
  initializePayment,
  verifyWebhookSignature,
  fulfillPayment,
  markPaymentFailed,
  getPaymentStatus,
  lookupPaymentsByEmail,
} from "../services/paymentService";
import { getIO } from "../sockets/io";

export const paymentsRouter = Router();

const initSchema = z.object({
  planKey: z.string().min(1),
  email: z.string().email(),
});

// Public — this is the customer-facing purchase entrypoint used by the
// portal's self-service buy page (frontend/src/pages/portal/PortalBuy.tsx),
// same trust model as the rest of /api/portal and /api/plans: no admin
// login exists yet at this point in the flow.
paymentsRouter.post("/initialize", async (req, res) => {
  const parsed = initSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  try {
    const origin = req.headers.origin || `${req.protocol}://${req.get("host")}`;
    const callbackUrl = `${origin}/portal/buy/complete`;
    const result = await initializePayment(parsed.data.planKey, parsed.data.email, callbackUrl);
    res.status(201).json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// Public — backs PortalRecover.tsx, the "I lost the page" fallback for a
// customer who paid but closed the tab before copying their PIN down (no
// SMS/email delivery in this build). Registered before the "/:reference"
// route below so "/lookup" isn't swallowed as a reference value.
const lookupSchema = z.object({ email: z.string().email() });
paymentsRouter.get("/lookup", async (req, res) => {
  const parsed = lookupSchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: "A valid email is required" });
  }
  const results = await lookupPaymentsByEmail(parsed.data.email);
  res.json({ vouchers: results });
});

// Public poll target for the "waiting for payment" screen the customer
// lands on after Paystack redirects them back to callback_url.
paymentsRouter.get("/:reference", async (req, res) => {
  const status = await getPaymentStatus(req.params.reference);
  if (!status) return res.status(404).json({ error: "Payment not found" });
  res.json(status);
});

// Paystack webhook — authenticated via HMAC signature over the raw body
// (see paymentService.verifyWebhookSignature), NOT the shared-secret header
// pattern middleware/auth.ts's requireWebhookSecret uses for the router's
// own usage-push webhook; Paystack's contract is signature-based only.
//
// Must be registered in the Paystack dashboard as
// https://<your-backend>/api/payments/webhook.
paymentsRouter.post("/webhook", async (req, res) => {
  const signature = req.headers["x-paystack-signature"] as string | undefined;
  const rawBody: Buffer | undefined = (req as any).rawBody;

  if (!verifyWebhookSignature(rawBody, signature)) {
    return res.status(401).json({ error: "Invalid signature" });
  }

  // Paystack expects a fast 2xx and retries on timeout — acknowledge first,
  // then fulfill. The work here is one INSERT/UPDATE plus a single RouterOS
  // call (via createVoucherBatch), not slow enough to need a real queue.
  res.sendStatus(200);

  const event = req.body;
  try {
    if (event?.event === "charge.success") {
      await fulfillPayment(event.data.reference);
      getIO().emit("payment:fulfilled", { reference: event.data.reference });
    } else if (event?.event === "charge.failed") {
      await markPaymentFailed(event.data.reference);
    }
  } catch (err: any) {
    console.error("[paymentsRouter] webhook handling failed:", err.message);
  }
});
