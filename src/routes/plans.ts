import { Router } from "express";
import { listPlans, exportPlanDataJs } from "../services/planService";
import { requireAdmin } from "../middleware/auth";

export const plansRouter = Router();

// Public — the frontend's voucher-creation dropdown needs this without login
// friction; adjust to requireAdmin if plans should stay fully internal.
plansRouter.get("/", async (_req, res) => {
  res.json({ plans: await listPlans() });
});

// Admin-only: regenerate plan-data.js to copy onto the router's /hotspot/
// directory, keeping login.html/status.html in sync with the DB (audit
// finding #2 fix — see planService.exportPlanDataJs for details).
plansRouter.get("/export.js", requireAdmin, async (_req, res) => {
  res.type("application/javascript").send(await exportPlanDataJs());
});
