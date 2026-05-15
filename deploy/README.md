# EC2 deploy (one-time bootstrap)

Cheap target: `t3.micro` / `t4g.small` on Ubuntu 24.04. Open inbound `:3000` (or
front it with nginx / an ALB) and `:22` from your IP only.

## 1. Provision the box

```bash
# as ubuntu@ec2
sudo apt update && sudo apt install -y git curl
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs

sudo mkdir -p /opt/warehouse-geocoder-utility
sudo chown ubuntu:ubuntu /opt/warehouse-geocoder-utility
git clone <repo-url> /opt/warehouse-geocoder-utility
cd /opt/warehouse-geocoder-utility
npm ci --omit=dev
npx prisma generate
```

## 2. Environment file

```bash
sudo tee /etc/warehouse-geocoder.env >/dev/null <<'EOF'
DATABASE_URL=postgresql://...
CRON_SECRET=...
PORT=3000
NODE_ENV=production
EOF
sudo chmod 600 /etc/warehouse-geocoder.env
```

## 3. systemd unit

```bash
sudo cp deploy/warehouse-geocoder.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now warehouse-geocoder
sudo systemctl status warehouse-geocoder
```

Logs: `journalctl -u warehouse-geocoder -f`.

## 4. GitHub Actions secrets

Set these in the repo (Settings → Secrets and variables → Actions):

- `EC2_HOST` — public DNS / IP of the instance
- `EC2_USER` — `ubuntu`
- `EC2_SSH_KEY` — private key matching an `authorized_keys` entry on the box

The `ubuntu` user also needs passwordless `sudo systemctl restart
warehouse-geocoder`. Add to `/etc/sudoers.d/warehouse-geocoder`:

```
ubuntu ALL=(ALL) NOPASSWD: /bin/systemctl restart warehouse-geocoder, /bin/systemctl status warehouse-geocoder
```

If the repo is private, add a deploy key to GitHub and place the matching
private key at `/home/ubuntu/.ssh/id_ed25519` on the instance so `git pull`
works non-interactively.
