# MOPDATEC WI-FI — pushes active-session usage to the full-stack backend
# every 30s, so the admin dashboard's Socket.IO feed stays live.
#
# This is the SAME payload shape backend/src/routes/usage.ts's
# POST /api/usage/webhook expects (JSON array of {user, sessionId, address,
# bytesIn, bytesOut}). $webhookUrl and $secret below MUST match your
# deployed backend URL and WEBHOOK_SHARED_SECRET env var exactly.
#
# This push is a DASHBOARD-FRESHNESS mechanism only — actual data-cap
# enforcement is native limit-bytes-total on the router (Issue 2's real
# fix), so a missed or delayed push here never lets anyone exceed their
# plan; it only means the dashboard is briefly stale.
#
# Run ONCE (New Terminal, or /import file-name=push-usage-webhook.rsc).
# Idempotent — re-running just replaces the existing script/scheduler.

:local webhookUrl "https://YOUR-BACKEND-HOST.onrender.com/api/usage/webhook"
:local secret "REPLACE-WITH-WEBHOOK_SHARED_SECRET-FROM-BACKEND-ENV"

:local scriptSource {
  :local sessions [/ip hotspot active print as-value]
  :if ([:len $sessions] > 0) do={
    :local payload "["
    :local first true
    :foreach s in $sessions do={
      :if (!$first) do={ :set payload ($payload . ",") }
      :set first false
      :local sid ($s->".id")
      :local uname ($s->"user")
      :local addr ($s->"address")
      :local bIn ($s->"bytes-in")
      :local bOut ($s->"bytes-out")
      :set payload ($payload . "{\"sessionId\":\"" . $sid . "\",\"user\":\"" . $uname . \
        "\",\"address\":\"" . $addr . "\",\"bytesIn\":" . $bIn . ",\"bytesOut\":" . $bOut . "}")
    }
    :set payload ($payload . "]")

    /tool fetch url=$webhookUrl http-method=post \
      http-header-field="Content-Type: application/json,X-Webhook-Secret: $secret" \
      http-data=$payload output=none
  }
}

:if ([:len [/system script find name="mopdatec-push-usage"]] = 0) do={
  /system script add name="mopdatec-push-usage" source=$scriptSource \
    comment="MOPDATEC: pushes active-session usage to the backend webhook"
} else={
  /system script set [find name="mopdatec-push-usage"] source=$scriptSource
}

:if ([:len [/system scheduler find name="mopdatec-push-usage"]] = 0) do={
  /system scheduler add name="mopdatec-push-usage" interval=30s \
    on-event="/system script run mopdatec-push-usage" \
    comment="MOPDATEC: runs the usage-push script every 30s"
  :log info "MOPDATEC: usage-push scheduler installed, runs every 30s"
} else={
  :log info "MOPDATEC: usage-push scheduler already exists, left as-is"
}
