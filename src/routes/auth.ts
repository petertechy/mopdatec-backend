import { Router } from "express";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { env } from "../config/env";
import { findAdminByUsername, verifyPassword } from "../services/adminService";

export const authRouter = Router();

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

/**
 * Looks up the admins table (bcrypt-hashed passwords) rather than a single
 * hardcoded username/password pair — lets more than one staff member log in
 * without sharing credentials. See adminService.ensureBootstrapAdmin(),
 * called once at startup in index.ts, for how the first admin row gets
 * there from ADMIN_USERNAME/ADMIN_PASSWORD; routes/admins.ts (behind this
 * same login) is how every admin after that gets created.
 */
authRouter.post("/login", async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "username and password are required" });
  }
  const { username, password } = parsed.data;

  const admin = await findAdminByUsername(username);
  if (!admin || !(await verifyPassword(password, admin.password_hash))) {
    return res.status(401).json({ error: "Invalid credentials" });
  }

  const token = jwt.sign({ username: admin.username, adminId: admin.id }, env.jwtSecret, { expiresIn: "12h" });
  res.json({ token });
});
