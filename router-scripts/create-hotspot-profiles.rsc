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
#   - idle-timeout        — deliberately DISABLED (none). A device that's
#                           still connected but just quiet for a few minutes
#                           (screen locked, no active traffic) must NOT lose
#                           its session over that alone — that was causing
#                           customers to get kicked mid-visit for no reason
#                           they could see. Ghost-session reaping for a
#                           device that's actually gone is keepalive-timeout's
#                           job instead (see below), not idle-timeout's.
#   - keepalive-timeout   — how long RouterOS holds an `active` session open
#                           after the device stops answering ARP entirely
#                           (i.e. it's actually gone — out of range, Wi-Fi
#                           off, powered down), not just quiet. Without this
#                           a device that leaves uncleanly (no explicit
#                           logout) would leave a ghost session that's never
#                           reaped — on a shared-users=1 plan that one slot
#                           stays taken, so the next login attempt gets
#                           "no more sessions are allowed" and the customer
#                           can't get back on.
#
# The data cap itself is set per-voucher at creation time via
# `limit-bytes-total` (Issue 2's fix), NOT at the profile level. If your
# hotspot setup uses a non-default address-pool, rate-limit, or other profile
# field, add it manually per profile after running this.
#
# Run once over WinBox New Terminal: /import file-name=create-hotspot-profiles.rsc

:local idle "none"
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
