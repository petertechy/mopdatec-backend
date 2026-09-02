# create-hotspot-profiles.rsc — one-time setup, safe to re-run.
#
# Creates the six hotspot user profiles the `plans` table's `profile` column
# references (see database/schema.sql's plan seed data). Voucher creation
# (voucherService.createHotspotUser(), routeros/client.ts) passes
# `=profile=<name>` when adding a RouterOS hotspot user — if that profile
# doesn't already exist on the router, the API call is rejected outright.
#
# Only sets `shared-users` (concurrent session count per voucher) — the data
# cap itself is set per-voucher at creation time via `limit-bytes-total`
# (Issue 2's fix), NOT at the profile level, so nothing else needs
# configuring here. If your hotspot setup uses a non-default address-pool,
# rate-limit, or other profile field, add it manually per profile after
# running this — this script deliberately doesn't guess at those.
#
# Run once over WinBox New Terminal: /import file-name=create-hotspot-profiles.rsc

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
        /ip hotspot user profile add name=$pname shared-users=$pshared
        :put ("created profile: " . $pname . " (shared-users=" . $pshared . ")")
    } else={
        :put ("profile already exists, skipping: " . $pname)
    }
}
