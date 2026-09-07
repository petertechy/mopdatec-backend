# create-hotspot-profiles.rsc — one-time setup, safe to re-run.
#
# Creates the six hotspot user profiles the `plans` table's `profile` column
# references (see database/schema.sql's plan seed data). Voucher creation
# (voucherService.createHotspotUser(), routeros/client.ts) passes
# `=profile=<name>` when adding a RouterOS hotspot user — if that profile
# doesn't already exist on the router, the API call is rejected outright.
#
# Sets, per profile:
#   - shared-users        — concurrent devices allowed per voucher
#   - idle-timeout        — how long RouterOS holds an `active` session open
#                           after the device stops sending traffic
#   - keepalive-timeout   — how long it holds one open after the device stops
#                           answering ARP entirely
#
# The two timeouts matter: without them a device that leaves uncleanly (screen
# sleep, out of range, Wi-Fi drop — no explicit logout) leaves a ghost session
# that never gets reaped. On a shared-users=1 plan that one slot stays taken,
# so the next login attempt gets "no more sessions are allowed" and the
# customer can't get back on. These match the router's stock "default"
# profile (5 min idle) — the earlier build of this script set them and a
# later rewrite dropped them, which is what caused the re-login failures.
#
# The data cap itself is set per-voucher at creation time via
# `limit-bytes-total` (Issue 2's fix), NOT at the profile level. If your
# hotspot setup uses a non-default address-pool, rate-limit, or other profile
# field, add it manually per profile after running this.
#
# Run once over WinBox New Terminal: /import file-name=create-hotspot-profiles.rsc

:local idle "00:05:00"
:local keepalive "00:02:00"

:local profiles {
    {"name"="LS"; "shared"=1};
    {"name"="standard"; "shared"=1};
    {"name"="Trader Pass"; "shared"=1};
    {"name"="Pro Weekly"; "shared"=2};
    {"name"="Pro Monthly"; "shared"=3};
    {"name"="Premium"; "shared"=5};
}

:foreach p in=$profiles do={
    :local pname ($p->"name")
    :local pshared ($p->"shared")
    :if ([/ip hotspot user profile find name=$pname] = "") do={
        /ip hotspot user profile add name=$pname shared-users=$pshared \
            idle-timeout=$idle keepalive-timeout=$keepalive
        :put ("created profile: " . $pname . " (shared-users=" . $pshared . ", idle-timeout=" . $idle . ")")
    } else={
        # Already exists — patch the timeouts in case it was created by the
        # earlier rewrite of this script that omitted them. shared-users is
        # left alone (an operator may have tuned it deliberately).
        /ip hotspot user profile set [/ip hotspot user profile find name=$pname] \
            idle-timeout=$idle keepalive-timeout=$keepalive
        :put ("profile exists — patched idle/keepalive timeouts: " . $pname)
    }
}
