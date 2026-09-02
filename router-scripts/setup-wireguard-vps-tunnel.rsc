# setup-wireguard-vps-tunnel.rsc — run on the ROUTER (WinBox New Terminal).
# Requires RouterOS v7+ (check first: /system resource print). Sets up a
# WireGuard tunnel to your VPS so the backend can reach the RouterOS API
# without exposing it to the public internet, and works even if this
# router is behind ISP-side CGNAT with no real public IP — the router
# initiates the tunnel outbound to the VPS, which does have one.
#
# Fill in the three variables below BEFORE running, then:
#   /import file-name=setup-wireguard-vps-tunnel.rsc
#
# You'll need the VPS's WireGuard public key first — generate the VPS side
# per deploy/DEPLOY.md's WireGuard section, get its public key, then come
# back and fill in $vpsPublicKey and $vpsEndpoint here.

:local vpsPublicKey "PASTE-VPS-WIREGUARD-PUBLIC-KEY-HERE"
:local vpsEndpoint "your.vps.public.ip.here"
:local vpsEndpointPort 51820

# --- From here down shouldn't need editing ---

/interface wireguard add name=wg-vps listen-port=51821 comment="tunnel to backend VPS"
:local routerPrivateKey [/interface wireguard get [find name=wg-vps] private-key]
:local routerPublicKey [/interface wireguard get [find name=wg-vps] public-key]

/ip address add address=10.10.10.2/24 interface=wg-vps comment="WireGuard tunnel to VPS"

/interface wireguard peers add \
    interface=wg-vps \
    public-key=$vpsPublicKey \
    endpoint-address=$vpsEndpoint \
    endpoint-port=$vpsEndpointPort \
    allowed-address=10.10.10.1/32 \
    persistent-keepalive=25s \
    comment="backend VPS — keepalive keeps this working through CGNAT/NAT"

# Allow the RouterOS API from the tunnel only — NOT opened on the WAN
# interface at all, unlike a plain port-forward would require. Added
# WITHOUT trying to guess where in your existing input-chain rule order it
# needs to sit (a blind :place-before against rules this script can't see
# risks landing after an existing drop rule and never taking effect, or
# erroring outright if there's more than one match) — added at the end,
# you need to check/move it in WinBox -> IP -> Firewall -> Filter Rules.
/ip firewall filter add \
    chain=input in-interface=wg-vps protocol=tcp dst-port=8728,8729 action=accept \
    comment="RouterOS API from backend VPS, via WireGuard only"

:put "=== Router's WireGuard public key (put this in the VPS's peer config) ==="
:put $routerPublicKey
:put ""
:put "Router's tunnel IP: 10.10.10.2 — this is what ROUTEROS_HOST should be set to in the backend's .env, NOT this router's WAN/public IP."
:put ""
:put "!! IMPORTANT: open WinBox -> IP -> Firewall -> Filter Rules and confirm the new 'RouterOS API from backend VPS' accept rule sits ABOVE any existing drop/reject rule in the input chain — this script added it at the end, which may be too late to ever be reached depending on your existing rule order."
:put ""
:put "Next: add a peer for THIS router on the VPS side (public key above, allowed-ips=10.10.10.2/32), then verify with: /interface wireguard peers print — a recent 'last-handshake' means it's working."
