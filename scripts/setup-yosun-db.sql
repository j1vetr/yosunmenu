-- Yosun Menu — tam tablo kurulumu (tüm migration'lar dahil)
-- Kullanım: sudo -u postgres psql -d yosun_menu -f /var/www/yosunmenu/scripts/setup-yosun-db.sql

-- USERS
CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  username      VARCHAR(64) NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMP NOT NULL DEFAULT NOW()
);

-- SETTINGS
CREATE TABLE IF NOT EXISTS settings (
  id               SERIAL PRIMARY KEY,
  slug             VARCHAR(64) NOT NULL UNIQUE,
  restaurant_name  TEXT NOT NULL DEFAULT 'Restaurant',
  logo_url         TEXT,
  primary_color    VARCHAR(16) DEFAULT '#C9A84C',
  currency         VARCHAR(8)  DEFAULT 'TRY',
  default_language VARCHAR(8)  DEFAULT 'tr',
  openai_key       TEXT,
  hero_image_url   TEXT,
  opening_hours    TEXT,
  instagram        TEXT,
  tagline          TEXT,
  quality_note     TEXT,
  address          TEXT,
  description      TEXT,
  logo_width       INTEGER,
  price_updated_at TEXT,
  wifi_name        TEXT,
  wifi_password    TEXT,
  maps_url         TEXT,
  location_notes   JSONB DEFAULT '{}',
  updated_at       TIMESTAMP NOT NULL DEFAULT NOW()
);

-- LANGUAGES
CREATE TABLE IF NOT EXISTS languages (
  id         SERIAL PRIMARY KEY,
  code       VARCHAR(8) NOT NULL UNIQUE,
  name       VARCHAR(64) NOT NULL,
  is_active  BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INTEGER NOT NULL DEFAULT 0
);

-- CATEGORIES
CREATE TABLE IF NOT EXISTS categories (
  id         SERIAL PRIMARY KEY,
  slug       VARCHAR(128) NOT NULL UNIQUE,
  image_url  TEXT,
  emoji      VARCHAR(8),
  note       TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active  BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS categories_sort_idx ON categories(sort_order);

-- CATEGORY TRANSLATIONS
CREATE TABLE IF NOT EXISTS category_translations (
  id            SERIAL PRIMARY KEY,
  category_id   INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  language_code VARCHAR(8) NOT NULL,
  name          TEXT NOT NULL,
  description   TEXT,
  UNIQUE(category_id, language_code)
);

-- PRODUCTS
CREATE TABLE IF NOT EXISTS products (
  id              SERIAL PRIMARY KEY,
  category_id     INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  slug            VARCHAR(128) NOT NULL UNIQUE,
  image_url       TEXT,
  price           REAL NOT NULL DEFAULT 0,
  currency        VARCHAR(8) DEFAULT 'TRY',
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order      INTEGER NOT NULL DEFAULT 0,
  is_popular      BOOLEAN NOT NULL DEFAULT FALSE,
  portion_min     INTEGER,
  portion_max     INTEGER,
  portion_unit    VARCHAR(8),
  calories        INTEGER,
  allergens       JSONB DEFAULT '[]',
  nutrition_facts JSONB DEFAULT '{}',
  created_at      TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS products_category_idx ON products(category_id);

-- PRODUCT TRANSLATIONS
CREATE TABLE IF NOT EXISTS product_translations (
  id            SERIAL PRIMARY KEY,
  product_id    INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  language_code VARCHAR(8) NOT NULL,
  name          TEXT NOT NULL,
  description   TEXT,
  ingredients   TEXT,
  allergen_note TEXT,
  special_note  TEXT,
  UNIQUE(product_id, language_code)
);

-- ANALYTICS EVENTS
CREATE TABLE IF NOT EXISTS analytics_events (
  id            SERIAL PRIMARY KEY,
  type          VARCHAR(32) NOT NULL,
  product_id    INTEGER REFERENCES products(id) ON DELETE SET NULL,
  language_code VARCHAR(8),
  user_agent    TEXT,
  created_at    TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS analytics_type_idx    ON analytics_events(type);
CREATE INDEX IF NOT EXISTS analytics_created_idx ON analytics_events(created_at);
CREATE INDEX IF NOT EXISTS analytics_product_idx ON analytics_events(product_id);

-- AI GENERATION LOGS
CREATE TABLE IF NOT EXISTS ai_generation_logs (
  id            SERIAL PRIMARY KEY,
  product_id    INTEGER REFERENCES products(id) ON DELETE SET NULL,
  product_name  TEXT NOT NULL,
  model         VARCHAR(64) NOT NULL DEFAULT 'gpt-4o-mini',
  tokens_used   INTEGER,
  success       BOOLEAN NOT NULL DEFAULT TRUE,
  error_message TEXT,
  created_at    TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ai_logs_product_idx ON ai_generation_logs(product_id);

-- SEED: Admin kullanıcısı (toov / Toov1453@@)
INSERT INTO users (username, password_hash)
VALUES ('toov', '$2b$12$0AYtZWbbFrgAZfSeKRCt1.9vn66QeipAuB6IY1RzvX7eP7gtSRfsu')
ON CONFLICT (username) DO NOTHING;

-- SEED: Temel ayarlar
INSERT INTO settings (slug, restaurant_name, primary_color, currency, default_language)
VALUES ('main', 'Restaurant', '#C9A84C', 'TRY', 'tr')
ON CONFLICT (slug) DO NOTHING;

-- SEED: Diller
INSERT INTO languages (code, name, is_active, sort_order) VALUES
  ('tr', 'Türkçe',   TRUE, 0),
  ('en', 'English',  TRUE, 1),
  ('ru', 'Русский',  TRUE, 2),
  ('ar', 'العربية',  TRUE, 3)
ON CONFLICT (code) DO NOTHING;
