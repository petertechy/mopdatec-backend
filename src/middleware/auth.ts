import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { env } from "../config/env";
import { getTokenValidAfter } from "../services/adminService";

export interface AuthedRequest extends Request {
  admin?: { username: string; adminId: number };
}

interface AdminJwtPayload {
  username: string;
  adminId: number;
  iat: number; // seconds since epoch — set automatically by jwt.sign()
}

export async function requireAdmin(req: AuthedRequest, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Missing bearer token" });
  }
  const token = header.slice("Bearer ".length);

  let payload: AdminJwtPayload;
  try {
    payload = jwt.verify(token, env.jwtSecret) as AdminJwtPayload;
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }

  // Revocation check — see adminService.revokeSessions(). One extra indexed
  // lookup per authenticated request, in exchange for actually being able
  // to kill a token before its natural 12h expiry (lost device, staff
  // offboarding) instead of just waiting it out. Fails closed: a DB error
  // here means "can't verify this session is still valid", not "assume
  // it's fine".
  try {
    const tokenValidAfter = await getTokenValidAfter(payload.adminId);
    if (tokenValidAfter && payload.iat * 1000 < tokenValidAfter.getTime()) {
      return res.status(401).json({ error: "Session has been revoked — please log in again" });
    }
  } catch (err: any) {
    console.error("[requireAdmin] revocation check failed:", err?.message || err);
    return res.status(503).json({ error: "Could not verify session — please try again" });
  }

  req.admin = { username: payload.username, adminId: payload.adminId };
  next();
}

/** Separate, simpler guard for the router's own webhook push — a shared secret header, not a JWT. */
export function requireWebhookSecret(req: Request, res: Response, next: NextFunction) {
  const secret = req.headers["x-webhook-secret"];
  if (secret !== env.webhookSharedSecret) {
    return res.status(401).json({ error: "Invalid webhook secret" });
  }
  next();
}
