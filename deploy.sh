#!/usr/bin/env bash
set -euo pipefail

DEPLOY_DIR="/var/www/yosunmenu"
BRANCH="mains"
PM2_APP="yosunmenu"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
log()  { echo -e "${GREEN}[yosunup]${NC} $1"; }
fail() { echo -e "${RED}[yosunup] HATA:${NC} $1"; exit 1; }

cd "$DEPLOY_DIR" || fail "$DEPLOY_DIR bulunamadı"

[ -f "$DEPLOY_DIR/.env" ] || fail ".env dosyası bulunamadı. Bkz: /var/www/yosunmenu/.env"

log "Kod güncelleniyor..."
git fetch origin
git reset --hard "origin/$BRANCH"

log "Bağımlılıklar yükleniyor..."
pnpm install --frozen-lockfile

log "Veritabanı şeması güncelleniyor... (drizzle-kit push)"
pnpm run db:push

log "API server build ediliyor..."
pnpm --filter @workspace/api-server run build

log "Frontend build ediliyor..."
pnpm --filter @workspace/qr-menu run build

log "PM2 yeniden başlatılıyor..."
pm2 restart "$PM2_APP"

sleep 2
log "✅ Deploy tamamlandı!"
pm2 list | grep "$PM2_APP" || true
