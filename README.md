# K6 Load Tester

Web UI for running k6 load tests with real-time console output.

Enter a URL, set virtual users and duration, click **Start**, and watch the k6 output stream live in the browser.

## Security (username/password and token)

You can lock the app so only authorized users can access it.

Set these environment variables before start:

```bash
AUTH_ENABLED=true
AUTH_USERNAME=admin
AUTH_PASSWORD=strong-password-here
# Optional: API/token access for scripts
APP_ACCESS_TOKEN=your-random-long-token
```

When `AUTH_ENABLED=true`:
- Browser users authenticate with username/password (HTTP Basic Auth prompt).
- API/automation clients can also use `Authorization: Bearer <APP_ACCESS_TOKEN>` if token is set.
- WebSocket log streaming is protected too (same auth rules).

## Local development

```bash
npm install
npm start          # http://localhost:3000
```

Requires **Node.js 18+** and **k6** on your PATH.

### Local secure run (recommended)

```bash
# Linux/macOS
AUTH_ENABLED=true AUTH_USERNAME=admin AUTH_PASSWORD=change-me npm start
```

```powershell
# Windows PowerShell
$env:AUTH_ENABLED="true"
$env:AUTH_USERNAME="admin"
$env:AUTH_PASSWORD="change-me"
npm start
```

## Deploy to OVHcloud VPS

```bash
# SSH into your VPS
ssh root@YOUR_VPS_IP

# Upload files (from local machine)
scp -r ./* root@YOUR_VPS_IP:/tmp/k6-app/

# On the VPS
cd /tmp/k6-app
chmod +x deploy.sh
./deploy.sh
```

The script installs Node.js, k6, PM2 and starts the app on port 3000.

Open `http://YOUR_VPS_IP:3000` in a browser.

## ngrok deployment/exposure

If your client needs temporary external access without opening DNS/Nginx:

```bash
# On VPS
sudo snap install ngrok
ngrok config add-authtoken <YOUR_NGROK_TOKEN>
ngrok http 3000
```

ngrok will print a public URL like:
- `https://xxxx-xx-xx-xx-xx.ngrok-free.app`

Share that URL with the client. They will still need your app username/password because app-level auth is enabled.

For ngrok agent and reserved domain details, use the official docs: [https://ngrok.com/docs](https://ngrok.com/docs)

## PM2 commands

```bash
pm2 logs k6-load-tester   # view logs
pm2 restart k6-load-tester # restart
pm2 stop k6-load-tester    # stop
```
