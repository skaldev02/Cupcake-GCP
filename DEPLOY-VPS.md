# Complete Deployment Guide – OVHcloud VPS

Deploy the **K6 Load Tester** app on your OVHcloud VPS (Ubuntu 23.04).

This guide includes:
- secure login protection (username/password, optional token)
- optional ngrok public URL setup for client access

**Your VPS details (from your screenshot):**
- **IP:** `51.178.55.237`
- **OS:** Ubuntu 23.04
- **Specs:** 1 vCore, 2 GB RAM, 20 GB storage
- **Hostname:** `vps-4f2e6af0.vps.ovh.net`

---

## Part 1: Prerequisites on Your Windows PC

### 1.1 Get SSH access to the VPS

You need either:

- **Option A – Password:** The root (or admin) password OVH sent when you created the VPS (check email or OVH control panel).
- **Option B – SSH key:** If you already added an SSH key in OVH (Security & Operations), use that.

### 1.2 Open a terminal

- **PowerShell** (Win + X → Windows PowerShell), or  
- **Windows Terminal**, or  
- **Git Bash** if you have Git installed.

---

## Part 2: Connect to Your VPS

### 2.1 SSH connection

From your PC, run (replace `root` with your username if you use a different user):

```powershell
ssh root@51.178.55.237
```

If using a specific key:

```powershell
ssh -i "C:\path\to\your\private_key" root@51.178.55.237
```

- First time: accept the fingerprint with `yes`.
- Enter the password when prompted (nothing will appear as you type).

You should see a prompt like `root@vps-4f2e6af0:~#`.

### 2.2 (Optional) Create a non-root user

Recommended for security:

```bash
adduser deploy
usermod -aG sudo deploy
su - deploy
```

Then use `deploy@51.178.55.237` for SSH and run `sudo` when needed. The rest of the guide uses `root` for simplicity; if you use `deploy`, prefix commands with `sudo` where needed.

---

## Part 3: Deploy the App (Two Options)

### Option A: One-command deploy (recommended)

Use this if you can copy the project onto the VPS (e.g. with `scp` or Git).

#### Step 1: Copy the project to the VPS

From your **Windows PC** (in PowerShell), in the project folder:

```powershell
cd C:\Users\LENOVO\OneDrive\Desktop\k6-testing\Cupcake-GCP
scp -r . root@51.178.55.237:~/cupcake-app
```

(If you use a different user, replace `root` with e.g. `deploy`.)

#### Step 2: SSH in and run the deploy script

```bash
ssh root@51.178.55.237
cd ~/cupcake-app
chmod +x deploy.sh
./deploy.sh
```

The script will:

1. Update the system  
2. Install Node.js 20  
3. Install k6  
4. Install PM2  
5. Deploy the app to `/opt/k6-load-tester` and start it with PM2  

When it finishes, open: **http://51.178.55.237:3000**

### Security config (required before sharing URL)

Edit `/opt/k6-load-tester/.env`:

```bash
cd /opt/k6-load-tester
nano .env
```

Use secure values:

```env
PORT=3000
AUTH_ENABLED=true
AUTH_USERNAME=admin
AUTH_PASSWORD=use-a-strong-password
# Optional token for API scripts
APP_ACCESS_TOKEN=long-random-token
```

Then restart:

```bash
pm2 restart k6-load-tester --update-env
```

---

### Option B: Manual step-by-step deploy

If you prefer to run each step yourself or the script fails, follow this.

#### 1. Update the system

```bash
sudo apt-get update -y && sudo apt-get upgrade -y
```

#### 2. Install Node.js 20

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v   # should show v20.x
npm -v
```

#### 3. Install k6

```bash
sudo gpg --no-default-keyring \
  --keyring /usr/share/keyrings/k6-archive-keyring.gpg \
  --keyserver hkp://keyserver.ubuntu.com:80 \
  --recv-keys C5AD17C747E3415A3642D57D77C6C491D6AC1D69

echo "deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] https://dl.k6.io/deb stable main" \
  | sudo tee /etc/apt/sources.list.d/k6.list

sudo apt-get update && sudo apt-get install -y k6
k6 version
```

#### 4. Install PM2 (process manager)

```bash
sudo npm install -g pm2
```

#### 5. Deploy the app

```bash
sudo mkdir -p /opt/k6-load-tester
# Copy your project files here (e.g. from ~/cupcake-app if you used scp)
sudo cp -r ~/cupcake-app/* /opt/k6-load-tester/
sudo chown -R $USER:$USER /opt/k6-load-tester
cd /opt/k6-load-tester
npm install --omit=dev
```

#### 6. Start with PM2 and enable startup on boot

```bash
pm2 delete k6-load-tester 2>/dev/null || true
pm2 start server.js --name k6-load-tester
pm2 save
sudo env PATH="$PATH" pm2 startup systemd -u $USER --hp $HOME
```

#### 7. Open port 3000 in the firewall

```bash
sudo ufw allow 3000/tcp
sudo ufw status
# If UFW was inactive, you can enable it: sudo ufw enable
```

Then open: **http://51.178.55.237:3000**

---

## Part 4: OVH Firewall (Security Groups)

OVH can block traffic at the hypervisor. If you cannot reach the app:

1. In OVH: **Bare Metal Cloud → Virtual Private Servers** → your VPS.  
2. Go to **Network** (or **Security & Operations**).  
3. Find **Firewall** / **Security groups** and ensure **TCP 3000** (and 22 for SSH) is allowed for your IP or `0.0.0.0/0` if you want public access.

---

## Part 5: Useful Commands After Deploy

| Task | Command |
|------|--------|
| View app logs | `pm2 logs k6-load-tester` |
| Restart app | `pm2 restart k6-load-tester` |
| Stop app | `pm2 stop k6-load-tester` |
| Status | `pm2 status` |
| List processes | `pm2 list` |

---

## Part 6: Updating the App Later

From your PC, copy updated files and restart:

```powershell
cd C:\Users\LENOVO\OneDrive\Desktop\k6-testing\Cupcake-GCP
scp -r . root@51.178.55.237:~/cupcake-app
```

On the VPS:

```bash
cd /opt/k6-load-tester
sudo cp -r ~/cupcake-app/* .
npm install --omit=dev
pm2 restart k6-load-tester
```

---

## Part 7: Optional – Nginx Reverse Proxy and HTTPS

For a domain and HTTPS (e.g. `https://k6.yourdomain.com`):

1. Point your domain’s A record to `51.178.55.237`.
2. On the VPS, install Nginx and Certbot:

```bash
sudo apt-get install -y nginx certbot python3-certbot-nginx
sudo certbot --nginx -d k6.yourdomain.com
```

3. Add a site config, e.g. `/etc/nginx/sites-available/k6`:

```nginx
server {
    listen 80;
    server_name k6.yourdomain.com;
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/k6 /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

Then run Certbot for that domain to get HTTPS.

---

## Part 8: Optional – ngrok secure share URL

Use this when you want to quickly share the app with a client without DNS/Nginx setup.

### 8.1 Install and configure ngrok

```bash
sudo snap install ngrok
ngrok config add-authtoken <YOUR_NGROK_TOKEN>
```

### 8.2 Start tunnel

```bash
ngrok http 3000
```

You will get a public URL like:
`https://xxxx-xx-xx-xx-xx.ngrok-free.app`

### 8.3 Share securely

Share ngrok URL with your client, and give them app login credentials (`AUTH_USERNAME` / `AUTH_PASSWORD`).

For ngrok setup variants (reserved domains, edge, agent config), see [https://ngrok.com/docs](https://ngrok.com/docs).

---

## Quick Reference

- **App URL:** http://51.178.55.237:3000  
- **SSH:** `ssh root@51.178.55.237`  
- **App directory on VPS:** `/opt/k6-load-tester`  
- **Process manager:** PM2, service name `k6-load-tester`
- **Security:** set `AUTH_ENABLED=true` and strong credentials in `/opt/k6-load-tester/.env`

If something fails, check `pm2 logs k6-load-tester` and that port 3000 is open (UFW and OVH firewall).
