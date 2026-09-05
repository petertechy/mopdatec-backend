import express from "express";
import cors from "cors";
import { createServer } from "http";
import { Server } from "socket.io";

import { env } from "./config/env";
import { setIO } from "./sockets/io";
import { authRouter } from "./routes/auth";
import { adminsRouter } from "./routes/admins";
import { vouchersRouter } from "./routes/vouchers";
import { plansRouter } from "./routes/plans";
import { usageRouter } from "./routes/usage";
import { portalRouter } from "./routes/portal";
import { paymentsRouter } from "./routes/payments";
import { statsRouter } from "./routes/stats";
import { ensureBootstrapAdmin } from "./services/adminService";
import { startExpiryCron } from "./services/expiryService";
import { getCachedRouterHealth, startRouterHealthMonitor } from "./services/routerHealthService";

// Last-resort net for node-routeros (1.6.9, unmaintained since Jan 2021)
// throwing synchronously from inside its own internal socket/event-handling
// code — not a promise rejection or an 'error' event on anything we hold a
// reference to, so no try/catch in our own request-handling code can ever
// be in the right call stack to catch it. This session found and fixed the
// specific known case (see routeros/client.ts's Channel.onUnknown patch for
// "!empty" replies), which was crashing the entire backend process on every
// RouterOS print returning zero rows — but given how unmaintained this
// dependency is against a RouterOS version it predates by years, treat this
// as "the first bug we found," not "the only one that exists": anything
// else it throws this way still crashes the process today without this
// guard. Scoped tightly to errors that actually originate from
// node-routeros (by stack trace) — anything else still crashes and
// restarts normally, since swallowing an unrelated fatal bug could leave
// the process in a genuinely broken state that's worse to keep running.
process.on("uncaughtException", (err) => {
  if (err?.stack?.includes("node-routeros")) {
    console.error("[uncaughtException] swallowed a node-routeros internal error — a RouterOS call in flight failed, nothing else is affected:", err);
    return;
  }
  console.error("[uncaughtException] fatal, not from node-routeros — letting the process exit so systemd restarts it clean:", err);
  process.exit(1);
});

const app = express();
app.use(cors({ origin: env.corsOrigins, credentials: true }));
// `verify` stashes the exact request bytes on req.rawBody before JSON
// parsing touches them — needed by routes/payments.ts's webhook handler to
// check Paystack's HMAC signature, which is computed over the raw body, not
// a re-serialized version of the parsed object. Harmless for every other
// route, which just ignores rawBody.
app.use(
  express.json({
    verify: (req, _res, buf) => {
      (req as any).rawBody = buf;
    },
  }),
);

// Answers from routerHealthService's cache rather than re-testing live —
// see that file's comment on why. Freshness is bounded by its 20s poll
// interval, which is a fine trade for an endpoint the dashboard may hit
// every page load.
app.get("/api/health", (_req, res) => {
  res.json({ ok: true, ...getCachedRouterHealth() });
});

app.use("/api/auth", authRouter);
app.use("/api/admins", adminsRouter);
app.use("/api/vouchers", vouchersRouter);
app.use("/api/plans", plansRouter);
app.use("/api/usage", usageRouter);
app.use("/api/portal", portalRouter);
app.use("/api/payments", paymentsRouter);
app.use("/api/stats", statsRouter);

app.use((req, res) => {
  res.status(404).json({ error: `No route: ${req.method} ${req.path}` });
});

// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error("[unhandled error]", err);
  res.status(500).json({ error: "Internal server error" });
});

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: env.corsOrigins, credentials: true },
});
setIO(io);

io.on("connection", (socket) => {
  console.log(`[socket] admin dashboard connected: ${socket.id}`);
  socket.on("disconnect", () => console.log(`[socket] disconnected: ${socket.id}`));
});

ensureBootstrapAdmin()
  .catch((err) => console.error("[server] failed to bootstrap admin account:", err))
  .finally(() => {
    startExpiryCron();
    startRouterHealthMonitor();
    httpServer.listen(env.port, () => {
      console.log(`[server] listening on :${env.port} (${env.nodeEnv})`);
    });
  });
