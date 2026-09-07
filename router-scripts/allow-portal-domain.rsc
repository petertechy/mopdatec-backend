# MOPDATEC WI-FI — walled-garden rules for the externally-hosted portal
#
# REQUIRED for the parts of the portal that are the Vercel SPA: the status
# page (status.html redirects there) and the "Buy Voucher Online" link on
# login.html. Without these rules an unauthenticated client can't reach the
# portal domain, so those fail silently. This is on top of, not instead of,
# the OS-captive-check domains already allowed by verify-captive-portal.rsc.
#
# NOT needed for login/logout themselves — login.html, logout.html and
# error.html are plain router-served HTML again (the form POSTs straight to
# $(link-login-only)), so the critical auth path works even if this rule is
# missing or the portal domain is unreachable.
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
