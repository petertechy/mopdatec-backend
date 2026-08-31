import { Router } from "express";
import { getUsageForVoucher, refreshVoucherUsage, markRedeemed } from "../services/usageService";

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

// Called by the portal login page immediately after it submits the auth form
// to the router — best-effort bookkeeping, not part of the auth flow itself
// (the router doesn't wait on or care about this call).
portalRouter.post("/redeemed/:pin", async (req, res) => {
  await markRedeemed(req.params.pin.toUpperCase());
  res.json({ ok: true });
});
