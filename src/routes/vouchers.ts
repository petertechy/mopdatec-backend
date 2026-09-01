import { Router } from "express";
import { z } from "zod";
import { requireAdmin, AuthedRequest } from "../middleware/auth";
import { createVoucherBatch, listVouchers, disableVoucher } from "../services/voucherService";
import { logAction } from "../services/auditService";

const listQuerySchema = z.object({
  search: z.string().trim().min(1).optional(),
  planKey: z.string().min(1).optional(),
  status: z.enum(["active", "not_synced", "expired", "disabled"]).optional(),
  sort: z.enum(["asc", "desc"]).optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
});

export const vouchersRouter = Router();
vouchersRouter.use(requireAdmin);

const createSchema = z.object({
  planKey: z.string().min(1),
  qty: z.number().int().min(1).max(500),
});

// Issue 5: creation + enabling happen in this single request — the RouterOS
// user is created with disabled=no in the same API call (see voucherService).
vouchersRouter.post("/", async (req: AuthedRequest, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  try {
    const vouchers = await createVoucherBatch(parsed.data.planKey, parsed.data.qty);
    await logAction(req.admin!.username, "voucher_batch_created", {
      planKey: parsed.data.planKey,
      qty: parsed.data.qty,
      pins: vouchers.map((v) => v.pin),
    });
    res.status(201).json({ vouchers });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Search/filter/sort — see voucherService.listVouchers's doc comment for why
// this all happens in one query instead of the dashboard filtering
// client-side.
vouchersRouter.get("/", async (req, res) => {
  const parsed = listQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  const vouchers = await listVouchers(parsed.data);
  res.json({ vouchers });
});

// Issue 4: bulk-disable every active session under this PIN + block future logins.
// Logged here at the route level (not inside voucherService.disableVoucher
// itself) so the audit trail reflects staff actions specifically — the
// expiry cron and the usage-cap backup enforcement also call
// disableVoucher() directly, but those are automated, not something a
// human decided, so they deliberately don't show up as "admin did this".
vouchersRouter.post("/:pin/disable", async (req: AuthedRequest, res) => {
  try {
    const result = await disableVoucher(req.params.pin);
    await logAction(req.admin!.username, "voucher_disabled", { pin: req.params.pin, ...result });
    res.json({ pin: req.params.pin, ...result });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});
