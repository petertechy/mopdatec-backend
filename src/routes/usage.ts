import { Router } from "express";
import { z } from "zod";
import { requireAdmin, requireWebhookSecret } from "../middleware/auth";
import { getActiveUsage, ingestUsageEvent } from "../services/usageService";
import { listActiveSessions } from "../routeros/client";
import { getIO } from "../sockets/io";

export const usageRouter = Router();

// Dashboard's initial load (before the first Socket.IO push arrives).
usageRouter.get("/active", requireAdmin, async (_req, res) => {
  res.json({ sessions: await getActiveUsage() });
});

// Manual "refresh from router" button — the polling FALLBACK path (see
// Issue 2 notes: this is a backup for dashboard freshness, not enforcement;
// enforcement is native limit-bytes-total on the router regardless of this).
usageRouter.post("/poll", requireAdmin, async (_req, res) => {
  try {
    const sessions = await listActiveSessions();
    const results = [];
    for (const s of sessions) {
      const row = await ingestUsageEvent({
        user: s.user,
        sessionId: s.sessionId,
        address: s.address,
        bytesIn: s.bytesIn,
        bytesOut: s.bytesOut,
      });
      if (row) results.push(row);
    }
    getIO().emit("usage:bulk-update", results);
    res.json({ polled: results.length });
  } catch (err: any) {
    res.status(502).json({ error: `RouterOS poll failed: ${err.message}` });
  }
});

const webhookEventSchema = z.object({
  user: z.string().min(1),
  sessionId: z.string().min(1),
  address: z.string().min(1),
  bytesIn: z.number(),
  bytesOut: z.number(),
  bytesRemaining: z.number().nullable().optional(),
});
const webhookBatchSchema = z.array(webhookEventSchema);

/**
 * Receives the push from router-scripts/push-usage-webhook.rsc (runs on the
 * router's own scheduler every 30s via /tool fetch — see that script for the
 * exact payload shape). Every event in the batch is ingested, then the
 * resulting rows are broadcast to any connected admin dashboards in real
 * time over Socket.IO, so the usage bars update live without the browser
 * polling anything itself.
 */
usageRouter.post("/webhook", requireWebhookSecret, async (req, res) => {
  const parsed = webhookBatchSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const updates = [];
  for (const event of parsed.data) {
    const row = await ingestUsageEvent(event);
    if (row) updates.push(row);
  }

  if (updates.length > 0) {
    getIO().emit("usage:bulk-update", updates);
  }
  res.json({ received: parsed.data.length, updated: updates.length });
});
