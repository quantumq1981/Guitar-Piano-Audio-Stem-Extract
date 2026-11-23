# Processing server on Oracle Cloud Always Free (phone-friendly)

This sets up a free, always-on HTTPS server for the Stem Splitter app using only a phone browser. You never need SSH.

What you get:

- An Ampere A1 VM (4 ARM cores, 24 GB RAM). A separation session peaks around 2.4 GiB, so there is plenty of headroom.
- The `stemsplit` API behind Caddy, with an automatic Let's Encrypt certificate.
- A free `sslip.io` hostname that maps to the VM's IP, so you don't need a domain.

## 1. Account

Sign up at **cloud.oracle.com → Sign up**. A card is needed for identity verification; Always Free resources are not charged.

Pick a home region carefully, because it can't be changed. Ampere A1 capacity is sometimes exhausted in busy regions. If instance creation later fails with *"Out of capacity"*, retry later or at a different time of day.

## 2. Create the VM

**Menu → Compute → Instances → Create instance**

| Field | Value |
|---|---|
| Name | `stemsplit` |
| Image | **Canonical Ubuntu 24.04** |
| Shape | **Ampere → VM.Standard.A1.Flex**, **4 OCPUs, 24 GB** memory (the Always Free maximum) |
| Networking | create a new VCN with a **public subnet**, and **assign a public IPv4 address** |
| SSH keys | "Generate a key pair" and save the private key (only for emergencies), or "No SSH keys" |
| **Advanced options → Management → Initialization script** | choose *Paste cloud-init script* and paste the two lines below |

```bash
#!/bin/bash
curl -fsSL https://raw.githubusercontent.com/quantumq1981/Guitar-Piano-Audio-Stem-Extract/main/deploy/oracle/setup.sh | bash
```

Press **Create**. Setup runs by itself on first boot and takes about 5–10 minutes.

## 3. Open ports 80 and 443 in Oracle's cloud firewall

The script opens the VM's own firewall. Oracle also has a network firewall in front of the VM, which you open in the console:

1. Go to **Instance → Primary VNIC → Subnet → Security Lists → Default Security List → Add Ingress Rules**.
2. Add one rule with Source CIDR `0.0.0.0/0`, IP protocol **TCP** and destination port `80`.
3. Add a second, identical rule with destination port `443`.

## 4. Check it

1. On the instance page, copy the **Public IP address**, for example `129.146.10.20`.
2. Replace the dots with dashes to get the hostname, for example `129-146-10-20.sslip.io`.
3. Open `https://129-146-10-20.sslip.io/v1/health`. You should see `{"ok":true,"queueDepth":0}`.

The certificate is requested once ports 80 and 443 are reachable. If the first try fails, Caddy keeps retrying, so give it a few minutes.

## 5. Point the app at it

1. On GitHub: **Settings → Secrets and variables → Actions → Variables → New repository variable**.
2. Set `VITE_API_BASE` to `https://129-146-10-20.sslip.io`, using your own IP.
3. Run **Actions → Deploy PWA to GitHub Pages → Run workflow**.
4. On the phone, open the Pages site, then use **Share → Add to Home Screen**.

## Keeping it alive

Oracle may **reclaim idle Always Free instances** in free-only accounts. "Idle" means CPU, network and memory use stayed under 20 % over 7 days, which is likely if you separate only a few songs a week. You have two options:

- **Upgrade the account to Pay As You Go** (Billing → Upgrade). Always Free resources stay free, and idle reclamation no longer applies. This is the reliable fix. Set a budget alert at $1 if you want a safety net.
- Or accept the risk: if the VM is reclaimed, create it again with the same steps. Update `VITE_API_BASE` if the IP changes.

## Updating and troubleshooting

To update to the latest `main`, re-run the installer. It is idempotent and keeps the signing secret, so existing download links stay valid:

```bash
sudo bash /opt/stemsplit/deploy/oracle/setup.sh
```

Without SSH, use the browser-based **Cloud Shell** (icon at the top right of the console), or **Instance → Console connection**.

| Symptom | Check |
|---|---|
| Health URL does not load at all | Security List rules from step 3; `sudo tail -50 /var/log/stemsplit-setup.log` |
| Certificate error | Caddy still issuing: `sudo journalctl -u caddy -n 50` |
| `{"error"...}` or 502 | API not running: `sudo journalctl -u stemsplit -n 50` |
| App says the server cannot be reached | `VITE_API_BASE` must match exactly (https, no trailing slash), then re-run the Pages workflow |

Settings live in `/etc/stemsplit/env` (`STEMSPLIT_CORS_ORIGIN`, the signing secret, the public URL). Restart after editing:

```bash
sudo systemctl restart stemsplit
```

Speed on Ampere A1 has not been measured yet. The ETA shown in the app assumes about 1× real time on 4 cores, so a 4-minute song should take roughly 4 minutes; treat that as an estimate.
