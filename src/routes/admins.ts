import { Router } from "express";
import { z } from "zod";
import { requireAdmin } from "../middleware/auth";
import { listAdmins, createAdmin } from "../services/adminService";

export const adminsRouter = Router();

// Every route here requires a valid staff session — this is how staff
// accounts get managed, so it can't itself be open to the public.
adminsRouter.use(requireAdmin);

adminsRouter.get("/", async (_req, res) => {
  const admins = await listAdmins();
  res.json({ admins });
});

const createSchema = z.object({
  username: z.string().min(3, "Username must be at least 3 characters"),
  password: z.string().min(8, "Password must be at least 8 characters"),
});

// Powers the "Manage Staff" screen — any signed-in admin can add another,
// same trust level as the rest of the dashboard (no separate "super admin"
// role exists yet).
adminsRouter.post("/", async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  try {
    const admin = await createAdmin(parsed.data.username, parsed.data.password);
    res.status(201).json(admin);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});
