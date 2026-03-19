# K6 Load Tester

Web UI for running k6 load tests with real-time console output.

Enter a URL, set virtual users and duration, click **Start**, and watch the k6 output stream live in the browser.

## Local development

```bash
npm install
npm start          # http://localhost:3000
```

Requires **Node.js 18+** and **k6** on your PATH.

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

## PM2 commands

```bash
pm2 logs k6-load-tester   # view logs
pm2 restart k6-load-tester # restart
pm2 stop k6-load-tester    # stop
```
