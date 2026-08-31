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
import { ensureBootstrapAdmin } from "./services/adminService";
import { startExpiryCron } from "./services/expiryService";
import { getCachedRouterHealth, startRouterHealthMonitor } from "./services/routerHealthService";

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
