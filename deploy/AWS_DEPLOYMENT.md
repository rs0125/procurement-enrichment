# AWS EC2 Deployment

The current release and CI/CD procedure is in [docs/CD.md](../docs/CD.md).
The original installation and backup paths below are retained for compatibility;
these bootstrap notes are historical and are not the current application release process.

This document records the live AWS deployment of `warehouse-geocoder-utility`
and the exact steps used to bring it up. Reproducible from a workstation with
the AWS CLI configured (`aws sts get-caller-identity` must succeed).

> ⚠️ The `.env` checked-into-the-box at `/etc/warehouse-geocoder.env` contains
> the Supabase DB password and `CRON_SECRET` in plaintext. If you tear down or
> re-share access, rotate both.

---

## 1. Live resources

| Resource | Value |
|---|---|
| AWS account | `111206816712` |
| Region | `ap-south-1` (Mumbai) |
| Instance ID | `i-0c32bf6ffaca045f1` |
| Instance type | `t4g.small` (Graviton, arm64) |
| AMI | `ami-00d1fb50a860331e7` (Ubuntu 24.04 LTS arm64) |
| Root volume | 20 GB gp3, delete-on-terminate |
| Public IP | `15.206.183.233` |
| Public DNS | `ec2-15-206-183-233.ap-south-1.compute.amazonaws.com` |
| Security group | `sg-0e754f68684fb823a` (`warehouse-geocoder-sg`) |
| VPC | `vpc-076c17050967effe8` (default) |
| Keypair (AWS) | `warehouse-geocoder-key` (ed25519) |
| Private key (local) | `~/.ssh/warehouse-geocoder-key.pem` (mode `600`) |
| App URL | `http://15.206.183.233:3000` |
| Health check | `http://15.206.183.233:3000/health` → `{"status":"ok","db":"connected"}` |

### Security group rules

| Port | Protocol | Source | Purpose |
|---|---|---|---|
| 22 | tcp | `171.76.75.225/32` | SSH (workstation IP only) |
| 3000 | tcp | `0.0.0.0/0` | App (needed so Supabase pg_cron can call in) |

---

## 2. Bootstrap (one-shot)

What was run, in order, from the workstation.

### 2.1 Create the SSH keypair

```bash
KEY_NAME=warehouse-geocoder-key
KEY_PATH=~/.ssh/${KEY_NAME}.pem

aws ec2 create-key-pair \
  --key-name "$KEY_NAME" \
  --key-type ed25519 \
  --query 'KeyMaterial' --output text \
  --region ap-south-1 > "$KEY_PATH"

chmod 600 "$KEY_PATH"
```

### 2.2 Create the security group

```bash
MY_IP=$(curl -s ifconfig.me)/32

VPC_ID=$(aws ec2 describe-vpcs --filters Name=isDefault,Values=true \
  --query 'Vpcs[0].VpcId' --output text --region ap-south-1)

SG_ID=$(aws ec2 create-security-group \
  --group-name warehouse-geocoder-sg \
  --description "Warehouse geocoder utility: SSH from my IP, HTTP 3000 open" \
  --vpc-id "$VPC_ID" \
  --query 'GroupId' --output text \
  --region ap-south-1)

aws ec2 authorize-security-group-ingress --group-id "$SG_ID" --region ap-south-1 \
  --ip-permissions "IpProtocol=tcp,FromPort=22,ToPort=22,IpRanges=[{CidrIp=$MY_IP,Description=ssh-from-rs0125}]"
aws ec2 authorize-security-group-ingress --group-id "$SG_ID" --region ap-south-1 \
  --ip-permissions "IpProtocol=tcp,FromPort=3000,ToPort=3000,IpRanges=[{CidrIp=0.0.0.0/0,Description=app-port}]"
```

### 2.3 Launch the instance

```bash
# Latest Ubuntu 24.04 arm64 AMI in ap-south-1 (refresh before re-running)
AMI=$(aws ec2 describe-images --owners 099720109477 \
  --filters "Name=name,Values=ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-arm64-server-*" \
            "Name=state,Values=available" \
  --query 'sort_by(Images, &CreationDate)[-1].ImageId' \
  --output text --region ap-south-1)

INSTANCE_ID=$(aws ec2 run-instances \
  --image-id "$AMI" \
  --instance-type t4g.small \
  --key-name warehouse-geocoder-key \
  --security-group-ids "$SG_ID" \
  --block-device-mappings 'DeviceName=/dev/sda1,Ebs={VolumeSize=20,VolumeType=gp3,DeleteOnTermination=true}' \
  --tag-specifications 'ResourceType=instance,Tags=[{Key=Name,Value=warehouse-geocoder},{Key=Project,Value=wareongo}]' \
  --region ap-south-1 \
  --query 'Instances[0].InstanceId' --output text)

aws ec2 wait instance-running --instance-ids "$INSTANCE_ID" --region ap-south-1

HOST=$(aws ec2 describe-instances --instance-ids "$INSTANCE_ID" --region ap-south-1 \
  --query 'Reservations[0].Instances[0].PublicIpAddress' --output text)
echo "$HOST"
```

### 2.4 Push the code

`rsync` from the workstation (excluding `node_modules`, `.git`, the generated
Prisma client, and `.env` — the env file is installed separately as root-owned).

```bash
SSH_OPTS="-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -i ~/.ssh/warehouse-geocoder-key.pem"

ssh $SSH_OPTS ubuntu@$HOST \
  'sudo mkdir -p /opt/warehouse-geocoder-utility && sudo chown ubuntu:ubuntu /opt/warehouse-geocoder-utility'

rsync -az --delete \
  --exclude node_modules \
  --exclude .git \
  --exclude src/generated/prisma \
  --exclude .env \
  -e "ssh $SSH_OPTS" \
  ./ ubuntu@$HOST:/opt/warehouse-geocoder-utility/
```

### 2.5 Install Node 22 + deps on the box

```bash
ssh $SSH_OPTS ubuntu@$HOST 'bash -se' <<'REMOTE'
set -euxo pipefail
sudo apt-get update -qq
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq curl ca-certificates gnupg
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nodejs
cd /opt/warehouse-geocoder-utility
npm ci --omit=dev --no-audit --no-fund
npx prisma generate
REMOTE
```

### 2.6 Install the env file

Built from the workstation's `.env` (comments and surrounding double-quotes
stripped, `PORT`/`NODE_ENV` added), then uploaded and installed root-owned:

```bash
TMP=$(mktemp)
awk '
  /^[[:space:]]*#/ {next}
  /^[[:space:]]*$/ {next}
  { sub(/=[[:space:]]*"/, "=", $0); sub(/"[[:space:]]*$/, "", $0); print }
' .env > "$TMP"
grep -q '^PORT='     "$TMP" || echo 'PORT=3000'         >> "$TMP"
grep -q '^NODE_ENV=' "$TMP" || echo 'NODE_ENV=production' >> "$TMP"

scp $SSH_OPTS "$TMP" ubuntu@$HOST:/tmp/warehouse-geocoder.env
ssh $SSH_OPTS ubuntu@$HOST \
  'sudo install -m 600 -o root -g root /tmp/warehouse-geocoder.env /etc/warehouse-geocoder.env \
   && rm /tmp/warehouse-geocoder.env'
rm "$TMP"
```

### 2.7 Install + start the systemd unit

```bash
ssh $SSH_OPTS ubuntu@$HOST '
  sudo cp /opt/warehouse-geocoder-utility/deploy/warehouse-geocoder.service /etc/systemd/system/ &&
  sudo systemctl daemon-reload &&
  sudo systemctl enable --now warehouse-geocoder &&
  sudo systemctl status warehouse-geocoder --no-pager -l
'
```

### 2.8 Smoke test

```bash
curl -sS http://$HOST:3000/health
# → {"status":"ok","db":"connected"}
```

---

## 3. Day-to-day operations

All commands assume the workstation has `~/.ssh/warehouse-geocoder-key.pem`.

```bash
HOST=15.206.183.233
SSH="ssh -i ~/.ssh/warehouse-geocoder-key.pem ubuntu@$HOST"
```

### SSH in

```bash
$SSH
```

### Tail logs

```bash
$SSH 'journalctl -u warehouse-geocoder -f'
```

### Restart the service

```bash
$SSH 'sudo systemctl restart warehouse-geocoder'
```

### Deploy a code change

```bash
rsync -az --delete \
  --exclude node_modules --exclude .git \
  --exclude src/generated/prisma --exclude .env \
  -e "ssh -i ~/.ssh/warehouse-geocoder-key.pem" \
  ./ ubuntu@$HOST:/opt/warehouse-geocoder-utility/

$SSH '
  cd /opt/warehouse-geocoder-utility &&
  npm ci --omit=dev --no-audit --no-fund &&
  npx prisma generate &&
  sudo systemctl restart warehouse-geocoder
'
```

### Update environment variables

```bash
$SSH 'sudo -e /etc/warehouse-geocoder.env && sudo systemctl restart warehouse-geocoder'
```

### Update the security group source IP

Your home IP changes — re-allow SSH from the new one and revoke the old:

```bash
SG_ID=sg-0e754f68684fb823a
OLD_IP=171.76.75.225/32
NEW_IP=$(curl -s ifconfig.me)/32

aws ec2 authorize-security-group-ingress --group-id $SG_ID --region ap-south-1 \
  --ip-permissions "IpProtocol=tcp,FromPort=22,ToPort=22,IpRanges=[{CidrIp=$NEW_IP,Description=ssh-from-rs0125}]"
aws ec2 revoke-security-group-ingress    --group-id $SG_ID --region ap-south-1 \
  --ip-permissions "IpProtocol=tcp,FromPort=22,ToPort=22,IpRanges=[{CidrIp=$OLD_IP}]"
```

---

## 4. Cost & lifecycle

`t4g.small` in `ap-south-1` is roughly **$0.0168/hr (~$12/mo)** plus ~$1.60/mo
for the 20 GB gp3 root volume. Stopping the instance keeps the disk but stops
the hourly compute charge.

### Stop (keeps disk, releases public IP)

```bash
aws ec2 stop-instances --instance-ids i-0c32bf6ffaca045f1 --region ap-south-1
```

Note: stopping releases the dynamic public IP. Either allocate an Elastic IP or
re-read `PublicIpAddress` from `describe-instances` after starting again.

### Start

```bash
aws ec2 start-instances --instance-ids i-0c32bf6ffaca045f1 --region ap-south-1
```

### Full teardown

```bash
aws ec2 terminate-instances --instance-ids i-0c32bf6ffaca045f1 --region ap-south-1
aws ec2 wait instance-terminated --instance-ids i-0c32bf6ffaca045f1 --region ap-south-1
aws ec2 delete-security-group --group-id sg-0e754f68684fb823a --region ap-south-1
aws ec2 delete-key-pair --key-name warehouse-geocoder-key --region ap-south-1
rm ~/.ssh/warehouse-geocoder-key.pem
```

After teardown, **rotate the Supabase password and `CRON_SECRET`** — both lived
in plaintext on the terminated EBS volume.

---

## 5. On-box layout

| Path | Purpose |
|---|---|
| `/opt/warehouse-geocoder-utility/` | Application source (rsynced) |
| `/opt/warehouse-geocoder-utility/src/generated/prisma/` | Generated Prisma client (built on box) |
| `/etc/warehouse-geocoder.env` | Env file, `root:root 600`, loaded by systemd |
| `/etc/systemd/system/warehouse-geocoder.service` | Systemd unit (copy of `deploy/warehouse-geocoder.service`) |
| `journalctl -u warehouse-geocoder` | Logs (stdout + stderr) |

The unit runs `node --experimental-strip-types src/index.mjs` as `ubuntu` with
`Restart=on-failure`.
