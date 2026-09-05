import { RouterOSAPI, Channel, Receiver } from "node-routeros";
import { env } from "../config/env";

// node-routeros (1.6.9, unmaintained since Jan 2021 — no newer version
// exists) predates RouterOS v7's API protocol. A `print` command that
// matches zero rows gets a "!empty" reply on RouterOS v7 (v6 only ever sent
// "!done" for an empty result) — a perfectly normal reply this library's
// Channel class doesn't recognize. Its default handling for any unknown
// reply type is to synchronously THROW, from inside the raw socket's own
// 'data' event callback — not a promise rejection, not an 'error' event, so
// no try/catch anywhere in OUR code can ever be in the right call stack to
// catch it. It became an uncaught exception that killed the entire backend
// process — confirmed live: e.g. every /ip/hotspot/active/print call made
// while no one is connected to the hotspot, climbing the systemd restart
// counter by the hundreds. "!empty" means exactly what "!done" with no rows
// means, so patch it to behave that way instead. Must run before any
// RouterOS connection is made (module load time, here, qualifies).
(Channel.prototype as any).onUnknown = function (this: any, reply: string) {
  if (reply === "!empty") {
    if (!this.trapped) this.emit("done", this.data);
    this.close();
    return;
  }
  // Anything else really is unexpected — still throws (still uncatchable
  // from our own code, same as before), but index.ts's uncaughtException
  // guard catches RouterOS-library errors specifically as a last-resort net,
  // rather than this one patch being the only thing standing between any
  // future undiscovered protocol quirk and a full process crash.
  throw new Error(`RouterOS API: unexpected reply type "${reply}"`);
};

// Second, distinct crash found the same way: Receiver.sendTagData() throws
// synchronously ("UNREGISTEREDTAG") whenever a reply sentence arrives tagged
// for a request this library has already stopped listening to — a stray/
// late packet for a Channel that already closed (e.g. it already got its
// "!done" and cleaned up, but one more trailing sentence for that same tag
// arrives right after). Nothing depends on that data anymore — there's no
// pending promise left to resolve — so this is safe to just drop instead of
// crashing the whole process over it. Same reasoning as the "!empty" patch
// above: a plain `throw` deep inside the raw socket's own 'data' handling,
// unreachable by any try/catch in our own code.
(Receiver.prototype as any).sendTagData = function (this: any, currentTag: string) {
  const tag = this.tags.get(currentTag);
  if (tag) {
    tag.callback(this.currentPacket);
  }
  this.cleanUp();
};

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

/**
 * Real removal, not disable — used only for vouchers voucherService.deleteVoucher
 * has already confirmed have no usage/payment history, so there's nothing
 * router-side worth keeping either. Kicks any active session first (same as
 * disableVoucherEverywhere), then removes the hotspot user entry entirely
 * rather than just setting disabled=yes.
 */
export async function deleteHotspotUserEverywhere(pin: string): Promise<void> {
  await withConnection(async (api) => {
    const active = await api.write("/ip/hotspot/active/print", [`?user=${pin}`]);
    for (const session of active as any[]) {
      await api.write("/ip/hotspot/active/remove", [`=.id=${session[".id"]}`]);
    }

    const users = await api.write("/ip/hotspot/user/print", [`?name=${pin}`]);
    for (const user of users as any[]) {
      await api.write("/ip/hotspot/user/remove", [`=.id=${user[".id"]}`]);
    }
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
