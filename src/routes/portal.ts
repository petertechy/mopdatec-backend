import { Router } from "express";
import { z } from "zod";
import {
  pushEnabled,
  getPublicKey,
  isAllowedPushEndpoint,
  saveSubscription,
  removeSubscription,
  hasSubscription,
  VoucherNotFoundForPushError,
  TooManySubscriptionsError,
} from "../services/pushService";
import {
  getUsageForVoucher,
  refreshVoucherUsage,
  markRedeemed,
} from "../services/usageService";
import {
  logoutVoucherEverywhere,
  logoutVoucherSession,
} from "../routeros/client";

export const portalRouter = Router();

// Public by design — same trust model as the router itself, where the PIN
// doubles as username+password. Anyone who can already log in with a PIN
// can equally see that PIN's own usage; this doesn't expose OTHER vouchers.
portalRouter.get("/usage/:pin", async (req, res) => {
  const usage = await getUsageForVoucher(req.params.pin.toUpperCase());
  if (!usage) return res.status(404).json({ error: "Voucher not found" });
  res.json(usage);
});

// Portal's own "Refresh" button (PortalStatus.tsx) — the customer-facing
// counterpart to the dashboard's admin-only POST /api/usage/poll. See
// usageService.refreshVoucherUsage for the per-PIN cooldown that keeps this
// from hammering the router on repeated taps.
portalRouter.post("/usage/:pin/refresh", async (req, res) => {
  const usage = await refreshVoucherUsage(req.params.pin.toUpperCase());
  if (!usage) return res.status(404).json({ error: "Voucher not found" });
  res.json(usage);
});

// Removes all active devices using this voucher, but leaves the voucher
// enabled so the customer can log in again on any device.
portalRouter.post("/logout-all/:pin", async (req, res) => {
  try {
    const result = await logoutVoucherEverywhere(req.params.pin.toUpperCase());
    res.json(result);
  } catch (err: any) {
    console.error(
      "[portal] failed to log out voucher sessions:",
      err?.message || err,
    );
    res
      .status(503)
      .json({ error: "Could not disconnect the voucher sessions right now" });
  }
});

// Removes only the previous session belonging to this client IP/MAC. Other
// devices using a shared voucher remain connected.
portalRouter.post("/logout-session/:pin", async (req, res) => {
  const ip = typeof req.body?.ip === "string" ? req.body.ip.trim() : "";
  const mac = typeof req.body?.mac === "string" ? req.body.mac.trim() : "";
  if (!ip && !mac) {
    return res.status(400).json({ error: "Client identity is required" });
  }

  try {
    const result = await logoutVoucherSession(
      req.params.pin.toUpperCase(),
      ip,
      mac,
    );
    res.json(result);
  } catch (err: any) {
    console.error(
      "[portal] failed to disconnect the previous client session:",
      err?.message || err,
    );
    res
      .status(503)
      .json({ error: "Could not clear the previous session right now" });
  }
});

// --- Browser push alerts (20/10/5% data left; 5/2 days before an unlimited
// plan expires). Public like the rest of the portal: the PIN is the
// credential. Endpoints are allow-listed to real push services (see
// pushService.isAllowedPushEndpoint) because the server POSTs to them.
const subscriptionSchema = z.object({
  endpoint: z.string().url().max(2048),
  keys: z.object({ p256dh: z.string().min(1).max(256), auth: z.string().min(1).max(256) }),
});
const endpointSchema = z.object({ endpoint: z.string().url().max(2048) });

portalRouter.get("/push/public-key", (_req, res) => {
  if (!pushEnabled()) return res.status(503).json({ error: "Push notifications are not enabled" });
  res.json({ publicKey: getPublicKey() });
});

portalRouter.post("/push/:pin/subscribe", async (req, res) => {
  if (!pushEnabled()) return res.status(503).json({ error: "Push notifications are not enabled" });
  const parsed = subscriptionSchema.safeParse(req.body);
  if (!parsed.success || !isAllowedPushEndpoint(parsed.data.endpoint)) {
    return res.status(400).json({ error: "Invalid push subscription" });
  }
  try {
    await saveSubscription(req.params.pin.toUpperCase(), parsed.data);
    res.json({ subscribed: true });
  } catch (err: any) {
    if (err instanceof VoucherNotFoundForPushError) return res.status(404).json({ error: "Voucher not found" });
    if (err instanceof TooManySubscriptionsError) {
      return res.status(429).json({ error: "Too many devices are already subscribed to this voucher" });
    }
    console.error("[portal] push subscribe failed:", err?.message || err);
    res.status(500).json({ error: "Could not save the subscription" });
  }
});

portalRouter.post("/push/:pin/unsubscribe", async (req, res) => {
  const parsed = endpointSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid request" });
  await removeSubscription(req.params.pin.toUpperCase(), parsed.data.endpoint);
  res.json({ subscribed: false });
});

// Lets the status page show "alerts on" for the browser it's open in.
portalRouter.post("/push/:pin/check", async (req, res) => {
  const parsed = endpointSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid request" });
  res.json({ subscribed: await hasSubscription(req.params.pin.toUpperCase(), parsed.data.endpoint) });
});

// Called by the portal login page immediately after it submits the auth form
// to the router — best-effort bookkeeping, not part of the auth flow itself
// (the router doesn't wait on or care about this call).
portalRouter.post("/redeemed/:pin", async (req, res) => {
  await markRedeemed(req.params.pin.toUpperCase());
  res.json({ ok: true });
});
