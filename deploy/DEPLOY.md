# Deploying to a VPS

Written generically for any Ubuntu 22.04+ VPS (DigitalOcean, Hetzner,
Vultr, Linode — interchangeable for this). Postgres stays on a separate
managed host (Render/Neon/Supabase) — the VPS only runs the Node backend.

Do these roughly in order — later steps depend on earlier ones.

## 0. Prerequisites to check first

- **RouterOS version 7+** on your router: `/system resource print` in
  WinBox. WireGuard (step 3) needs it. If you're on v6.x, stop here — that
  needs a different tunnel approach (OpenVPN), not covered by this runbook.
- **A domain or subdomain** you can point at the VPS (e.g.
  `api.yourdomain.com`) — needed for automatic HTTPS in step 5. Any DNS
  provider works; you just need to create an A record once you have the
  VPS's IP.
- **Whether your router has a real public WAN IP or is behind CGNAT** —
  doesn't actually matter for this runbook (WireGuard in step 3 works
  either way, since the router initiates the tunnel outbound), but good to
  know: if you were ever tempted to just port-forward instead, CGNAT would
  silently make that not work at all.

## 1. Provision the VPS

Any Ubuntu 22.04+ VPS, smallest size is plenty (this backend is not
resource-heavy — 1 vCPU / 1GB RAM is enough). Note its public IP once
created.

```bash
ssh root@<vps-ip>
apt update && apt upgrade -y
adduser mopdatec               # non-root user to run the app as
usermod -aG sudo mopdatec
ufw allow OpenSSH
ufw allow 80/tcp                # Caddy's ACME HTTP challenge
ufw allow 443/tcp                # HTTPS
ufw enable
```

## 2. Install Node.js and Caddy

```bash
# Node.js 20 LTS via NodeSource
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
apt install -y nodejs

# Caddy (reverse proxy + automatic HTTPS)
apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
apt update && apt install -y caddy
```

## 3. WireGuard tunnel to the router

This is what lets the VPS reach the RouterOS API without exposing it to
the whole internet, and works even behind CGNAT (see step 0). Read the
comments in `router-scripts/setup-wireguard-vps-tunnel.rsc` before running
anything on the router — it explains what each part does and one thing to
double-check afterward (firewall rule order).

**On the VPS:**
```bash
apt install -y wireguard
wg genkey | tee /etc/wireguard/privatekey | wg pubkey > /etc/wireguard/publickey
cat /etc/wireguard/publickey   # save this — the router needs it
```

Create `/etc/wireguard/wg0.conf` (as root):
```ini
[Interface]
PrivateKey = <contents of /etc/wireguard/privatekey>
Address = 10.10.10.1/24
ListenPort = 51820

[Peer]
# Router's public key — fill in AFTER running the router-side script below,
# which prints it out.
PublicKey = <router's WireGuard public key>
AllowedIPs = 10.10.10.2/32
```

```bash
ufw allow 51820/udp
systemctl enable --now wg-quick@wg0
```

**On the router:** edit the top of
`router-scripts/setup-wireguard-vps-tunnel.rsc` — set `$vpsPublicKey` to
the VPS's public key from above, and `$vpsEndpoint` to the VPS's public IP.
Run it in WinBox New Terminal. It prints the router's own public key —
paste that into the VPS's `wg0.conf` `[Peer]` section above, then:

```bash
systemctl restart wg-quick@wg0
wg show   # should show a recent "latest handshake" once the router connects
```

The router's `PersistentKeepalive` (already set in the script) means it
connects out to the VPS on its own — nothing further needed on the
router's side to keep the tunnel alive.

Once `wg show` shows a handshake, verify from the VPS:
```bash
ping 10.10.10.2   # the router, over the tunnel
```

**Also run** (if you haven't already) `create-hotspot-profiles.rsc` and
`verify-captive-portal.rsc` from `router-scripts/` — see the main
`README.md`'s router section for what each does.

## 4. Deploy the backend code

```bash
su - mopdatec
sudo mkdir -p /opt/mopdatec-backend
sudo chown mopdatec:mopdatec /opt/mopdatec-backend
cd /opt/mopdatec-backend
git clone <your-backend-github-url> .
npm install
```

Create `.env` (copy `.env.example` and fill in real values):
```bash
cp .env.example .env
nano .env
```

Key values for this deployment specifically:
- `DATABASE_URL` — from your managed Postgres (Render/Neon/Supabase)
- `DATABASE_SSL=true` — managed Postgres providers require this
- `ROUTEROS_HOST=10.10.10.2` — the router's WireGuard tunnel IP from step 3,
  **not** its LAN or WAN address
- `ROUTEROS_PORT=8728`, `ROUTEROS_TLS=false` — plain API is fine here since
  the WireGuard tunnel is already fully encrypted; no need for `api-ssl`
  on top of it
- `JWT_SECRET` / `WEBHOOK_SHARED_SECRET` — generate fresh values for
  production, don't reuse whatever's in your local dev `.env`:
  `openssl rand -hex 32`
- `ADMIN_USERNAME` / `ADMIN_PASSWORD` — real values, not dev placeholders
  (only used once, to seed the first admin — see `adminService.ensureBootstrapAdmin()`)
- `CORS_ORIGIN` — your frontend's Vercel URL (may not exist yet — circular
  with frontend deploy, see step 7)
- `PAYSTACK_SECRET_KEY` / `PAYSTACK_PUBLIC_KEY` — your test or live keys

```bash
npm run build
exit   # back to root/sudo user
```

## 5. systemd service + Caddy

```bash
sudo cp /opt/mopdatec-backend/deploy/mopdatec-backend.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now mopdatec-backend
sudo systemctl status mopdatec-backend   # should show "active (running)"
```

Point your domain's A record at the VPS's IP now, if you haven't. Then:
```bash
sudo cp /opt/mopdatec-backend/deploy/Caddyfile /etc/caddy/Caddyfile
sudo nano /etc/caddy/Caddyfile   # replace api.yourdomain.com with your real domain
sudo systemctl reload caddy
```

Caddy fetches a Let's Encrypt cert automatically on first request — give it
a minute, then:
```bash
curl https://api.yourdomain.com/api/health
```
Should return `{"ok":true,"routerConnected":true,...}` — `routerConnected:
true` confirms the WireGuard tunnel is actually working end-to-end, not
just that the backend process started.

## 6. Run the migration once

```bash
cd /opt/mopdatec-backend
node dist/db/migrate.js
```

## 7. Frontend, then close the CORS loop

Deploy the frontend to Vercel per its own `README.md`, with
`VITE_API_URL=https://api.yourdomain.com`. Once you have the resulting
Vercel URL, go back and set `CORS_ORIGIN` in the backend's `.env` to it,
then:
```bash
sudo systemctl restart mopdatec-backend
```

## 8. Router-side URLs + Paystack webhook

- Replace `YOUR-FRONTEND.vercel.app` in each
  `router-scripts/hotspot-stubs/*.html` with your real Vercel domain, then
  upload them to the router's `/hotspot/` files (WinBox → Files),
  overwriting the originals.
- Edit and run `router-scripts/allow-portal-domain.rsc` with that same
  domain.
- Edit `router-scripts/push-usage-webhook.rsc` — `$webhookUrl` =
  `https://api.yourdomain.com/api/usage/webhook`, `$secret` = your
  `WEBHOOK_SHARED_SECRET`. Run it.
- Register `https://api.yourdomain.com/api/payments/webhook` in the
  [Paystack dashboard](https://dashboard.paystack.co/#/settings/developer).

## 9. Verify end to end

- `GET https://api.yourdomain.com/api/health` → `routerConnected: true`
- Log into the deployed dashboard, create a test voucher, confirm
  `routerSynced: true` in the response (proves the WireGuard path actually
  works for real API calls, not just the health check)
- Connect a real device to the hotspot, confirm the captive portal popup
  triggers and the login page loads live plan data
- Test a Paystack payment in test mode end to end
- Check the router health badge on the dashboard shows green

## Redeploying after a code change

```bash
cd /opt/mopdatec-backend
git pull
npm install   # only if package.json changed
npm run build
sudo systemctl restart mopdatec-backend
```
