#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# yosunup — Yosun Menu deploy scripti
# Kullanım: sudo yosunup
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

DEPLOY_DIR="/var/www/yosunmenu"
BRANCH="mains"
PM2_APP="yosunmenu"
DB_NAME="yosun_menu"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

log()  { echo -e "${GREEN}[yosunup]${NC} $1"; }
warn() { echo -e "${YELLOW}[yosunup]${NC} $1"; }
fail() { echo -e "${RED}[yosunup] HATA:${NC} $1"; exit 1; }

cd "$DEPLOY_DIR" || fail "$DEPLOY_DIR bulunamadı"

# ── 1. Kodu çek ───────────────────────────────────────────────────────────────
log "Kod güncelleniyor... (git pull origin $BRANCH)"
git fetch origin
git reset --hard "origin/$BRANCH"

# ── 2. Bağımlılıkları yükle ───────────────────────────────────────────────────
log "Bağımlılıklar yükleniyor... (pnpm install)"
pnpm install --frozen-lockfile

# ── 3. Veritabanı migration'ları çalıştır ─────────────────────────────────────
log "Veritabanı migration'ları uygulanıyor..."
sudo -u postgres psql -d "$DB_NAME" -f "$DEPLOY_DIR/scripts/migrate.sql" \
  && log "Migration tamamlandı." \
  || warn "Migration sırasında bir uyarı oluştu (tablo zaten varsa normaldir)."

# ── 4. Build al ───────────────────────────────────────────────────────────────
log "API server build ediliyor..."
pnpm --filter @workspace/api-server run build

log "Frontend build ediliyor..."
pnpm --filter @workspace/qr-menu run build

# ── 5. PM2 restart ────────────────────────────────────────────────────────────
log "PM2 yeniden başlatılıyor... ($PM2_APP)"
pm2 restart "$PM2_APP"

sleep 2

# ── 6. Durum özeti ────────────────────────────────────────────────────────────
echo ""
log "✅ Deploy tamamlandı!"
pm2 list | grep "$PM2_APP" || true
echo ""
log "Son loglar için: pm2 logs $PM2_APP --lines 20 --nostream"
