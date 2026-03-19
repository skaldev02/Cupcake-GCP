#!/usr/bin/env bash
# One-command setup for OVHcloud VPS (Ubuntu/Debian)
set -euo pipefail

echo ""
echo "=============================="
echo " K6 Load Tester – VPS Setup"
echo "=============================="
echo ""

# 1. System update
echo "[1/5] Updating packages..."
sudo apt-get update -y && sudo apt-get upgrade -y

# 2. Node.js 20
echo "[2/5] Installing Node.js 20..."
if ! command -v node &>/dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
echo "  node $(node -v)  npm $(npm -v)"

# 3. k6
echo "[3/5] Installing k6..."
if ! command -v k6 &>/dev/null; then
  sudo gpg -k 2>/dev/null || true
  sudo gpg --no-default-keyring \
    --keyring /usr/share/keyrings/k6-archive-keyring.gpg \
    --keyserver hkp://keyserver.ubuntu.com:80 \
    --recv-keys C5AD17C747E3415A3642D57D77C6C491D6AC1D69
  echo "deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] https://dl.k6.io/deb stable main" \
    | sudo tee /etc/apt/sources.list.d/k6.list
  sudo apt-get update && sudo apt-get install -y k6
fi
echo "  $(k6 version)"

# 4. PM2
echo "[4/5] Installing PM2..."
sudo npm install -g pm2 2>/dev/null

# 5. App
APP=/opt/k6-load-tester
echo "[5/5] Deploying app to $APP..."
sudo mkdir -p "$APP"
sudo cp -r ./* "$APP/"
sudo chown -R "$USER:$USER" "$APP"
cd "$APP"
npm install --omit=dev

# Create .env for secure access if missing
if [ ! -f ".env" ]; then
  cat > .env <<'EOF'
PORT=3000
AUTH_ENABLED=true
AUTH_USERNAME=admin
AUTH_PASSWORD=change-me-now
# Optional API token auth
# APP_ACCESS_TOKEN=replace-with-random-token
EOF
  echo "  Created .env with default secure settings. Update AUTH_PASSWORD immediately."
fi

pm2 delete k6-load-tester 2>/dev/null || true
pm2 start server.js --name k6-load-tester --update-env
pm2 save
sudo env PATH="$PATH" pm2 startup systemd -u "$USER" --hp "$HOME" 2>/dev/null || true

# Firewall
sudo ufw allow 3000/tcp 2>/dev/null || true

IP=$(curl -s ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')
echo ""
echo "=============================="
echo " DONE!  Open http://$IP:3000"
echo "=============================="
echo ""
echo "Optional ngrok commands:"
echo "  sudo snap install ngrok"
echo "  ngrok config add-authtoken <YOUR_NGROK_TOKEN>"
echo "  ngrok http 3000"
echo ""
echo "Use AUTH_USERNAME/AUTH_PASSWORD from $APP/.env for secure access."
echo ""
