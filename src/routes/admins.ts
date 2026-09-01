import { Router } from "express";
import { z } from "zod";
import { requireAdmin, AuthedRequest } from "../middleware/auth";
import { listAdmins, createAdmin, revokeSessions } from "../services/adminService";
import { logAction, listRecentAuditLog } from "../services/auditService";

export const adminsRouter = Router();

// Every route here requires a valid staff session — this is how staff
// accounts get managed, so it can't itself be open to the public.
adminsRouter.use(requireAdmin);

adminsRouter.get("/", async (_req, res) => {
  const admins = await listAdmins();
  res.json({ admins });
});

// Registered before "/:id/..." below so "audit-log" is never captured as
// an :id value. Read-only history of who did what — see auditService.ts.
adminsRouter.get("/audit-log", async (req, res) => {
  const limit = req.query.limit ? Number(req.query.limit) : undefined;
  const entries = await listRecentAuditLog(limit);
  res.json({ entries });
});

const createSchema = z.object({
  username: z.string().min(3, "Username must be at least 3 characters"),
  password: z.string().min(8, "Password must be at least 8 characters"),
});

// Powers the "Manage Staff" screen — any signed-in admin can add another,
// same trust level as the rest of the dashboard (no separate "super admin"
// role exists yet).
adminsRouter.post("/", async (req: AuthedRequest, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  try {
    const admin = await createAdmin(parsed.data.username, parsed.data.password);
    await logAction(req.admin!.username, "admin_created", { newUsername: admin.username, newAdminId: admin.id });
    res.status(201).json(admin);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// Kicks every session currently issued for this admin (lost device, staff
// offboarding) — see adminService.revokeSessions() / middleware/auth.ts's
// requireAdmin for how a token gets rejected after this.
adminsRouter.post("/:id/revoke-sessions", async (req: AuthedRequest, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: "Invalid admin id" });
  }
  try {
    const admin = await revokeSessions(id);
    await logAction(req.admin!.username, "admin_sessions_revoked", {
      targetAdminId: admin.id,
      targetUsername: admin.username,
    });
    res.json({ ok: true, admin });
  } catch (err: any) {
    res.status(404).json({ error: err.message });
  }
});
