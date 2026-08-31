# MOPDATEC WI-FI — walled-garden rule for the externally-hosted portal
#
# REQUIRED once login.html/status.html/logout.html/error.html were switched
# from local /hotspot/ files to redirect stubs pointing at an external
# Vercel-hosted app (see router-scripts/hotspot-stubs/*.html and
# frontend/src/pages/portal/*.tsx). Without this rule, unauthenticated
# clients can't reach the portal domain at all, so the redirect itself would
# fail — this is on top of, not instead of, the OS-captive-check domains
# already allowed by verify-captive-portal.rsc (Issue 1).
#
# REPLACE the domain below with your actual deployed Vercel hostname.

:local portalDomain "YOUR-FRONTEND.vercel.app"

:if ([:len [/ip hotspot walled-garden find dst-host=$portalDomain]] = 0) do={
  /ip hotspot walled-garden add dst-host=$portalDomain action=allow disabled=no \
    comment="external portal domain — required for login/status/logout/error redirects"
  :log info "walled-garden: added allow rule for external portal domain ($portalDomain)"
} else={
  :log info "walled-garden: allow rule for $portalDomain already present"
}

:put "--- confirm the rule is active ---"
/ip hotspot walled-garden print where dst-host=$portalDomain
