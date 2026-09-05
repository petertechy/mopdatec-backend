# MOPDATEC WI-FI — walled-garden rules for the externally-hosted portal
#
# REQUIRED once login.html/status.html/logout.html/error.html were switched
# from local /hotspot/ files to redirect stubs pointing at an external
# Vercel-hosted app (see router-scripts/hotspot-stubs/*.html and
# frontend/src/pages/portal/*.tsx). Without these rules, unauthenticated
# clients can't reach the portal domain at all, so the redirect itself would
# fail — this is on top of, not instead of, the OS-captive-check domains
# already allowed by verify-captive-portal.rsc (Issue 1).
#
# Both the frontend domain AND the API domain are needed here — the loaded
# portal page's own JS calls the API directly (GET /api/plans, submitting
# login, etc.) while the customer is still unauthenticated, so allowing
# only the frontend domain lets the HTML/JS load but leaves every fetch()
# call from it silently blocked.
#
# The www variant is required too — Vercel automatically redirects between
# the bare and www forms of a custom domain (whichever isn't set as
# primary), so even though the hotspot stubs hardcode the bare domain, an
# unauthenticated client can still get bounced to the other form along the
# way. Missing it here isn't a cosmetic gap: the walled garden blocks
# whatever host isn't explicitly listed, so that redirect just fails
# silently for the customer (confirmed live — this exact gap was why a
# fresh login attempt "wasn't loading").
#
# REPLACE the domains below with your actual deployed hostnames.

:local portalDomains {"mopdatecwifi.com"; "www.mopdatecwifi.com"; "api.mopdatecwifi.com"}

:foreach portalDomain in=$portalDomains do={
  :if ([:len [/ip hotspot walled-garden find dst-host=$portalDomain]] = 0) do={
    /ip hotspot walled-garden add dst-host=$portalDomain action=allow disabled=no \
      comment="external portal domain — required for login/status/logout/error redirects"
    :log info "walled-garden: added allow rule for external portal domain ($portalDomain)"
  } else={
    :log info "walled-garden: allow rule for $portalDomain already present"
  }
}

:put "--- confirm all three rules are active ---"
/ip hotspot walled-garden print where dst-host="mopdatecwifi.com" or dst-host="www.mopdatecwifi.com" or dst-host="api.mopdatecwifi.com"
