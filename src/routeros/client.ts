import { RouterOSAPI } from "node-routeros";
import { env } from "../config/env";

// node-routeros connections are not safe to share across concurrent requests
// (it's a single stateful socket with request/response framing), so we open
// a short-lived connection per call rather than holding one global connection
// open. For this app's traffic volume (admin actions + periodic webhook
// upserts, not high-frequency trading) the connection overhead is negligible
// and it avoids an entire class of "socket got into a bad state" bugs.
async function withConnection<T>(fn: (api: RouterOSAPI) => Promise<T>): Promise<T> {
  const api = new RouterOSAPI({
    host: env.routeros.host,
    port: env.routeros.port,
    user: env.routeros.user,
    password: env.routeros.password,
    tls: env.routeros.tls ? {} : undefined,
    timeout: 8,
  });

  // RouterOSAPI is an EventEmitter and can emit its OWN async "error" event
  // straight off the underlying socket — a timeout or reset mid-request,
  // independent of whatever connect()/write() themselves return. Node.js
  // treats an "error" event with no listener as FATAL: it crashes the
  // entire process, not just this one call. That was happening for real —
  // routerHealthService pings the router every 20s, and any network hiccup
  // over the WireGuard tunnel would take the whole backend down (confirmed
  // live via repeated systemd restarts), leaving every request — including
  // ones with nothing to do with RouterOS — 502ing for the few seconds it
  // takes to come back up. Racing this promise turns that into an ordinary
  // rejection scoped to this one call instead.
  const errorPromise = new Promise<never>((_resolve, reject) => {
    api.once("error", reject);
  });

  try {
    await Promise.race([api.connect(), errorPromise]);
    return await Promise.race([fn(api), errorPromise]);
  } finally {
    try {
      api.close();
    } catch {
      /* already closed / never connected — safe to ignore */
    }
  }
}

export interface CreateHotspotUserParams {
  pin: string;
  profile: string;
  bytesLimit: number | null; // null = unlimited (Premium) — omit limit-bytes-total entirely
  expiresAt: string; // full ISO timestamp (see voucherService.expiryTimestamp) — reformatted below
  // for the router comment, which is informational only; the backend's own
  // expiryService cron is what actually disables the voucher on time.
}

export async function createHotspotUser(params: CreateHotspotUserParams): Promise<void> {
  await withConnection(async (api) => {
    // "2026-09-06 14:32 UTC" — readable at a glance in WinBox, vs. dumping
    // the raw "2026-09-06T14:32:10.185Z" ISO string into the comment.
    const expiresLabel = new Date(params.expiresAt).toISOString().replace("T", " ").slice(0, 16) + " UTC";
    const words = [
      `=name=${params.pin}`,
      `=password=${params.pin}`,
      `=profile=${params.profile}`,
      "=disabled=no", // Issue 5: created AND enabled in the same call
      `=comment=expires=${expiresLabel}`,
    ];
    if (params.bytesLimit !== null) {
      words.push(`=limit-bytes-total=${params.bytesLimit}`);
    }
    await api.write("/ip/hotspot/user/add", words);
  });
}

/**
 * Issue 4: disabling a shared voucher requires BOTH steps — removing every
 * active session under this PIN (kicks already-connected devices) AND
 * disabling the user (blocks future logins). Neither alone is sufficient.
 */
export async function disableVoucherEverywhere(pin: string): Promise<{ sessionsRemoved: number }> {
  return withConnection(async (api) => {
    const active = await api.write("/ip/hotspot/active/print", [`?user=${pin}`]);
    for (const session of active as any[]) {
      await api.write("/ip/hotspot/active/remove", [`=.id=${session[".id"]}`]);
    }

    const users = await api.write("/ip/hotspot/user/print", [`?name=${pin}`]);
    for (const user of users as any[]) {
      await api.write("/ip/hotspot/user/set", [`=.id=${user[".id"]}`, "=disabled=yes"]);
    }

    return { sessionsRemoved: active.length };
  });
}

export interface ActiveSession {
  sessionId: string;
  user: string; // voucher PIN
  address: string; // IP
  bytesIn: number;
  bytesOut: number;
  uptime: string;
}

/**
 * Polling fallback / manual refresh path — reads current active sessions
 * directly from the router. This is a BACKUP to the router-pushed webhook
 * (see routes/webhooks.ts), not the primary usage-detection mechanism, per
 * the Issue 2 fix: primary enforcement is native limit-bytes-total on the
 * router itself, which does not depend on this call happening in time.
 */
export async function listActiveSessions(): Promise<ActiveSession[]> {
  return withConnection(async (api) => {
    const rows = (await api.write("/ip/hotspot/active/print")) as any[];
    return rows.map((r) => ({
      sessionId: r[".id"],
      user: r.user,
      address: r.address,
      bytesIn: parseInt(r["bytes-in"] || "0", 10),
      bytesOut: parseInt(r["bytes-out"] || "0", 10),
      uptime: r.uptime,
    }));
  });
}

export async function testConnection(): Promise<boolean> {
  try {
    await withConnection(async (api) => {
      await api.write("/system/identity/print");
    });
    return true;
  } catch {
    return false;
  }
}
