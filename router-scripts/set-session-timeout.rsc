# set-session-timeout.rsc — one-time setup, safe to re-run.
#
# Implements "stay logged in indefinitely — reconnecting after being away
# should never show the login page again":
#   - Customer walks away / Wi-Fi drops, comes back any time in the next
#     30 days → router auto-reconnects them (no PIN re-entry, no login
#     page shown).
#
# How RouterOS actually does this:
#
# http-cookie-lifetime (on the HOTSPOT SERVER PROFILE, /ip hotspot
# profile — NOT the per-plan /ip hotspot user profile that
# create-hotspot-profiles.rsc manages). When a client authenticates,
# RouterOS sets a browser cookie alongside the session. As long as that
# cookie is still valid the next time the client's browser hits the login
# page, RouterOS uses it to re-authenticate silently instead of showing
# the PIN form — this is exactly what status.html's `?erase-cookie=on`
# logout link is clearing today. Set to 30 days here so it's effectively
# "never" for any realistic gap between visits. login-by must include
# "cookie" for this to fire at all — added if missing rather than
# overwriting the other methods already configured.
#
# This does NOT bypass real billing/expiry: RouterOS won't honor the
# cookie for a disabled or expired hotspot user, and expiryService.ts /
# limit-bytes-total are what actually disable a voucher on time — the
# cookie only skips re-typing the PIN for a still-valid voucher.
#
# keepalive-timeout (per-plan, already set by create-hotspot-profiles.rsc)
# still tears down the now-dead `active` session once a device stops
# answering ARP — that's unavoidable (RouterOS can't keep a session
# "active" for a radio that's off) and still needed so a shared-users=1
# voucher's slot doesn't stay stuck forever if that device never comes
# back. It doesn't affect the user-visible experience: reconnecting still
# skips the login page immediately via the cookie above, regardless of
# how long the gap was.
#
# Iterates every configured hotspot server (usually just one) and patches
# its profile directly rather than pre-building a deduped list — if two
# servers happen to share one profile, that profile just gets the same,
# idempotent set command run twice. Harmless, and avoids an empty-array
# literal RouterOS's script parser has choked on before.
#
# Run once over WinBox New Terminal: /import file-name=set-session-timeout.rsc

:local cookieLifetime "30d"
:local patchedAny false

:foreach hs in=[/ip hotspot find] do={
    :local pname [/ip hotspot get $hs profile]
    :if ([:len $pname] > 0) do={
        :local prof [/ip hotspot profile find name=$pname]
        :if ([:len $prof] = 0) do={
            :put ("!! Hotspot server profile \"" . $pname . "\" not found — skipping.")
        } else={
            :local loginBy [/ip hotspot profile get $prof login-by]
            :local hasCookie false
            :foreach method in=$loginBy do={
                :if ($method = "cookie") do={ :set hasCookie true }
            }
            :if ($hasCookie) do={
                /ip hotspot profile set $prof http-cookie-lifetime=$cookieLifetime
                :put ("patched \"" . $pname . "\": http-cookie-lifetime=" . $cookieLifetime)
            } else={
                /ip hotspot profile set $prof http-cookie-lifetime=$cookieLifetime login-by=($loginBy , "cookie")
                :put ("patched \"" . $pname . "\": http-cookie-lifetime=" . $cookieLifetime . ", added \"cookie\" to login-by")
            }
            :set patchedAny true
        }
    }
}

:if (!$patchedAny) do={
    :put "!! No hotspot server found (or none has a profile set) — nothing to configure. Run /ip hotspot setup first."
}
