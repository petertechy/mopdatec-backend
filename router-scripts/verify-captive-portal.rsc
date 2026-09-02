# verify-captive-portal.rsc — DIAGNOSTIC ONLY. Reports on common causes of
# "captive portal popup doesn't trigger" on a MikroTik hotspot; does not
# change any configuration itself. Written without live access to this
# router, so it checks rather than fixes — safer than guessing at firewall/
# DNS rule changes on a router I can't inspect or test against.
#
# The three most common root causes on a fresh hotspot setup:
#   1. Missing DNS redirect (dst-nat, port 53, unauthenticated clients ->
#      the router's own DNS) or HTTP redirect (dst-nat, port 80 -> hotspot)
#      — normally created automatically by /ip hotspot setup. If that
#      wizard was skipped or only partially run (plausible given this
#      project's "paste commands into Terminal" history), these can be
#      missing or incomplete.
#   2. Walled-garden over-permitting the OS canary-check domains
#      (captive.apple.com, connectivitycheck.gstatic.com,
#      www.msftconnecttest.com) — if these resolve/pass through untouched,
#      the OS's own connectivity check succeeds silently and never shows
#      the popup.
#   3. No hotspot server actually bound to the relevant interface.
#
# Run over WinBox New Terminal: /import file-name=verify-captive-portal.rsc
# Read the output — it doesn't change anything on its own.

:put "=== Hotspot servers ==="
:local hsCount [/ip hotspot print count-only]
:if ($hsCount = 0) do={
    :put "!! No hotspot server configured at all. Run /ip hotspot setup."
} else={
    /ip hotspot print
}

:put ""
:put "=== DNS redirect (port 53 dst-nat) — should exist for unauthenticated clients ==="
:local dnsNat [/ip firewall nat find dst-port=53 and protocol~"udp|tcp" and action=redirect]
:if ([:len $dnsNat] = 0) do={
    :put "!! No DNS redirect NAT rule found. This is normally created by /ip hotspot setup — without it, DNS for unauthenticated clients may not be intercepted, and OS captive-portal checks can resolve normally and never trigger the popup."
} else={
    :put "OK — found DNS redirect rule(s)."
}

:put ""
:put "=== HTTP redirect (port 80 dst-nat) — should exist for unauthenticated clients ==="
:local httpNat [/ip firewall nat find dst-port=80 and protocol=tcp and action=redirect]
:if ([:len $httpNat] = 0) do={
    :put "!! No port-80 redirect NAT rule found. Also normally created by /ip hotspot setup — this is what actually shows the login page when a client's browser (or OS canary check) requests any http:// URL."
} else={
    :put "OK — found HTTP redirect rule(s)."
}

:put ""
:put "=== Walled garden entries matching known OS captive-portal canary domains ==="
:local canaryDomains {"captive.apple.com"; "connectivitycheck.gstatic.com"; "www.msftconnecttest.com"; "www.msftncsi.com"; "detectportal.firefox.com"}
:local foundCanary false
:foreach d in=$canaryDomains do={
    :local matches [/ip hotspot walled-garden find dst-host~$d]
    :if ([:len $matches] > 0) do={
        :put ("!! Walled-garden entry allows " . $d . " through untouched — this specific domain's captive-portal check will silently succeed and the popup won't trigger for that OS.")
        :set foundCanary true
    }
}
:if (!$foundCanary) do={
    :put "OK — no walled-garden entries matching known canary-check domains."
}

:put ""
:put "=== Summary ==="
:put "If any '!!' lines appeared above, that's the likely cause. The most common real fix on a fresh/incomplete setup is re-running the official wizard: /ip hotspot setup — it configures the DNS/HTTP redirect rules and hotspot server correctly in one guided flow. Only remove a walled-garden canary entry if you're sure it was added by mistake; some setups allow specific domains deliberately."
