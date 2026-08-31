import { testConnection } from "../routeros/client";
import { getIO } from "../sockets/io";

const CHECK_INTERVAL_MS = 20 * 1000; // 20 seconds

export interface RouterHealth {
  routerConnected: boolean;
  checkedAt: string;
}

// Cached rather than re-tested on every request: testConnection() opens a
// real RouterOS socket (up to its 8s timeout when the router is down), so
// GET /api/health answering from cache keeps that endpoint cheap and fast
// even while the router is unreachable — the periodic monitor below is the
// only thing that actually pays the connection cost.
let cached: RouterHealth = { routerConnected: false, checkedAt: new Date().toISOString() };

export function getCachedRouterHealth(): RouterHealth {
  return cached;
}

/**
 * Fixes the "silent failure" gap: previously a RouterOS outage (router
 * offline, wrong creds, network path down) had no visible signal anywhere
 * except a customer complaining their voucher didn't work. This polls
 * testConnection() on an interval and broadcasts any change over the same
 * socket the dashboard already holds open for live usage — see
 * useRouterHealth.ts on the frontend.
 */
async function checkRouterHealth(): Promise<void> {
  const routerConnected = await testConnection();
  const changed = routerConnected !== cached.routerConnected;
  cached = { routerConnected, checkedAt: new Date().toISOString() };

  if (changed) {
    console.log(`[routerHealthService] router connection ${routerConnected ? "restored" : "lost"}`);
  }
  try {
    getIO().emit("router:health", cached);
  } catch {
    // Socket.IO not initialized yet (e.g. called before setIO()) — the next
    // tick will pick it up once it is; nothing to do here.
  }
}

let intervalHandle: ReturnType<typeof setInterval> | null = null;

/** Called once from index.ts at startup, after setIO(). */
export function startRouterHealthMonitor(): void {
  if (intervalHandle) return; // guards against double-start on hot reload

  checkRouterHealth().catch((err) => console.error("[routerHealthService] startup check failed:", err));
  intervalHandle = setInterval(() => {
    checkRouterHealth().catch((err) => console.error("[routerHealthService] check failed:", err));
  }, CHECK_INTERVAL_MS);

  console.log(`[routerHealthService] monitor started — checking every ${CHECK_INTERVAL_MS / 1000}s`);
}

export function stopRouterHealthMonitor(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}
