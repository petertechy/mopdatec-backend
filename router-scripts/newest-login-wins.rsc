# newest-login-wins.rsc — setup, safe to re-run.
#
# Problem it solves: a customer moves to another access point and their
# phone shows up with a DIFFERENT MAC address (different SSID, a range
# extender rewriting MACs, iOS "Rotating" private address). RouterOS sees a
# second device while the old session is still open — keepalive-timeout
# only reaps it minutes later — so on a 1-device plan the new login is
# refused with "no more sessions are allowed".
#
# Fix: "a plan allows N devices, the newest login wins".
#   - shared-users on each MOPDATEC plan profile is set to N+1 (one spare
#     slot), so the new login is never refused by RouterOS itself.
#   - on-login runs the mopdatec-newest-login-wins function, which, if the
#     voucher now has more than N sessions, closes the one that has been
#     IDLE LONGEST (a stale session left on another AP sends no traffic, so
#     it's the one picked — an actively-used device on a multi-device plan
#     is left alone).
#   - The closed device's cookies (HTTP + MAC cookie) are deliberately
#     KEPT. A phone that roams back to an access point where it had its
#     other MAC is then logged straight back in by MAC cookie (closing the
#     session it just left), so roaming stays automatic in both directions.
#     Two phones sharing one PIN on a 1-device plan end up pushing each
#     other off on every MAC-cookie re-login, so sharing still doesn't give
#     either a usable connection.
#
# The plan's real device limit (plans.shared_users in the database, N) is
# unchanged — only the router profile carries the +1 spare slot. The data
# cap (limit-bytes-total) is per voucher, not per device, so closing or
# adding sessions never changes how much data a voucher gets.
#
# MikroTicket's profile (profile_LOW-STANDARD-...) and any other profile
# not listed below is left untouched. A listed profile that already has an
# on-login script that isn't ours is skipped with a warning rather than
# overwritten.
#
# The function is called via :parse with named parameters rather than
# `/system script run` — the latter does NOT pass on-login's $user /
# $"mac-address" through to the script it runs.
#
# !! RouterOS gotcha that caused a live outage on 2026-09-30: inside
# `find where`, a variable with the same name as a property (e.g.
# `find where user=$user`) resolves to the PROPERTY, not the variable, so
# the filter matches EVERY row. The first version of this function did
# exactly that and logged out 28 customers' devices before it was rolled
# back. Hence: parameters are named pUser/pMac/pKeep (no property has
# those names), every candidate is re-checked with an explicit `get`
# before anything is removed, at most ONE session is closed per login, and
# the function refuses to act at all if it sees more sessions than the
# plan could possibly have.
#
# Rollout is staged: with rollout="test" (the default) only the
# TEST-mac-autologin profile is patched, as a 1-device plan. Test with a
# voucher on that profile, then change rollout to "all" and re-import.
# dryRun="yes" makes the function only LOG what it would close.
#
# Run over WinBox New Terminal: /import file-name=newest-login-wins.rsc
#
# Rollback (restores the old behaviour exactly):
#   /system script remove [find name="mopdatec-newest-login-wins"]
#   /ip hotspot user profile set [find name="LS"] shared-users=1 on-login=""
#   /ip hotspot user profile set [find name="standard"] shared-users=1 on-login=""
#   /ip hotspot user profile set [find name="Trader Pass"] shared-users=1 on-login=""
#   /ip hotspot user profile set [find name="Pro Weekly"] shared-users=2 on-login=""
#   /ip hotspot user profile set [find name="Pro Monthly"] shared-users=3 on-login=""
#   /ip hotspot user profile set [find name="Premium"] shared-users=5 on-login=""
#   /ip hotspot user profile set [find name="TEST-mac-autologin"] shared-users=2 on-login="mopdatec-mac-autologin-test"
# (Removing the script alone is enough to stop it acting: on-login then
# fails to load it and does nothing.)

:local fnName "mopdatec-newest-login-wins"

# "test" = TEST-mac-autologin only; "all" = the six MOPDATEC plans below.
:local rollout "all"
# "yes" = log what would be closed, change nothing.
:local dryRun "no"

# Must match plans.shared_users in database/schema.sql.
:local profiles {
    {"name"="LS"; "devices"=1};
    {"name"="standard"; "devices"=1};
    {"name"="Trader Pass"; "devices"=1};
    {"name"="Pro Weekly"; "devices"=2};
    {"name"="Pro Monthly"; "devices"=3};
    {"name"="Premium"; "devices"=5};
}
:if ($rollout != "all") do={
    :set profiles {{"name"="TEST-mac-autologin"; "devices"=1}}
}

:local fnSource "# Called from hotspot on-login as: \$f pUser=<voucher> pMac=<new device MAC> pKeep=<devices allowed> pDry=<yes|no>\r\
    \n# Installed by router-scripts/newest-login-wins.rsc - edit that file, not this script.\r\
    \n# Parameter names deliberately differ from every property name: inside `find where`,\r\
    \n# a variable named like a property resolves to the property and matches every row.\r\
    \n:if (([:typeof \$pUser] = \"nothing\") or ([:typeof \$pMac] = \"nothing\") or ([:typeof \$pKeep] = \"nothing\")) do={ :return 0 }\r\
    \n:local tag \"mopdatec newest-login-wins\"\r\
    \n:local nKeep [:tonum \$pKeep]\r\
    \n:if ((\$nKeep < 1) or ([:len \$pUser] = 0)) do={ :return 0 }\r\
    \n:local cands [:toarray \"\"]\r\
    \n:foreach s in=[/ip hotspot active find where user=\$pUser] do={\r\
    \n    :if (([/ip hotspot active get \$s user] = \$pUser) and ([/ip hotspot active get \$s mac-address] != \$pMac)) do={\r\
    \n        :set cands (\$cands , \$s)\r\
    \n    }\r\
    \n}\r\
    \n:if ([:len \$cands] < \$nKeep) do={ :return 0 }\r\
    \n:if ([:len \$cands] > \$nKeep) do={\r\
    \n    :log warning (\$tag . \": \" . \$pUser . \" has \" . [:len \$cands] . \" other sessions, expected at most \" . \$nKeep . \" - refusing to act\")\r\
    \n    :return 0\r\
    \n}\r\
    \n:local victim [:pick \$cands 0]\r\
    \n:local worst [/ip hotspot active get \$victim idle-time]\r\
    \n:foreach s in=\$cands do={\r\
    \n    :local idle [/ip hotspot active get \$s idle-time]\r\
    \n    :if (\$idle > \$worst) do={ :set victim \$s; :set worst \$idle }\r\
    \n}\r\
    \n:local vMac [/ip hotspot active get \$victim mac-address]\r\
    \n:if ([/ip hotspot active get \$victim user] != \$pUser) do={ :return 0 }\r\
    \n:if (\$pDry = \"yes\") do={\r\
    \n    :log info (\$tag . \" [dry-run]: \" . \$pUser . \" logged in on \" . \$pMac . \", would close session on \" . \$vMac . \" (idle \" . \$worst . \")\")\r\
    \n    :return 1\r\
    \n}\r\
    \n/ip hotspot active remove \$victim\r\
    \n:log info (\$tag . \": \" . \$pUser . \" logged in on \" . \$pMac . \", closed session on \" . \$vMac . \" (idle \" . \$worst . \")\")\r\
    \n:return 1"

:if ([/system script find name=$fnName] = "") do={
    /system script add name=$fnName source=$fnSource comment="MOPDATEC: newest hotspot login wins (see router-scripts/newest-login-wins.rsc)"
    :put ("created script: " . $fnName)
} else={
    /system script set [find name=$fnName] source=$fnSource
    :put ("updated script: " . $fnName)
}

:foreach p in=$profiles do={
    :local pname ($p->"name")
    :local devices ($p->"devices")
    :local prof [/ip hotspot user profile find name=$pname]
    :if ([:len $prof] = 0) do={
        :put ("!! profile \"" . $pname . "\" not found - skipped.")
    } else={
        :local current [/ip hotspot user profile get $prof on-login]
        :local isOurs ([:typeof [:find $current $fnName]] != "nil")
        :local isTestLogger ($current = "mopdatec-mac-autologin-test")
        :if (([:len $current] > 0) and (!$isOurs) and (!$isTestLogger)) do={
            :put ("!! profile \"" . $pname . "\" already has its own on-login script - left untouched: " . $current)
        } else={
            :local onLogin (":local f [:parse [/system script get [find name=\"" . $fnName . "\"] source]]; \$f pUser=\$user pMac=\$\"mac-address\" pKeep=" . $devices . " pDry=" . $dryRun)
            /ip hotspot user profile set $prof shared-users=($devices + 1) on-login=$onLogin
            :put ("patched \"" . $pname . "\": " . $devices . " device(s), shared-users=" . ($devices + 1) . ", dry-run=" . $dryRun)
        }
    }
}
