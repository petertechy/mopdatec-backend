import { Router } from "express";
import { z } from "zod";
import { requireAdmin } from "../middleware/auth";
import { getOverviewStats, getAnalyticsStats } from "../services/statsService";

export const statsRouter = Router();
statsRouter.use(requireAdmin);

// Backs the dashboard's Overview page — see statsService.getOverviewStats
// for what each field means and how it's computed.
statsRouter.get("/overview", async (_req, res) => {
  const stats = await getOverviewStats();
  res.json(stats);
});

const analyticsQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(90).optional(),
});

// Backs the Analytics page. `days` is a preset (7/14/30/90 in the UI) but
// accepted as any 1-90 here — the query itself doesn't care which preset
// picked it.
statsRouter.get("/analytics", async (req, res) => {
  const parsed = analyticsQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  const stats = await getAnalyticsStats(parsed.data.days ?? 14);
  res.json(stats);
});
