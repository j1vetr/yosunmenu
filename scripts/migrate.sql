-- Yosun Menu — idempotent migration (tüm ALTER TABLE'lar IF NOT EXISTS ile)
-- Güvenle defalarca çalıştırılabilir, var olan kolonları atlar.

-- settings ek kolonlar
ALTER TABLE settings ADD COLUMN IF NOT EXISTS price_updated_at text;
ALTER TABLE settings ADD COLUMN IF NOT EXISTS wifi_name text;
ALTER TABLE settings ADD COLUMN IF NOT EXISTS wifi_password text;
ALTER TABLE settings ADD COLUMN IF NOT EXISTS maps_url text;
ALTER TABLE settings ADD COLUMN IF NOT EXISTS location_notes jsonb DEFAULT '{}';

-- categories ek kolonlar
ALTER TABLE categories ADD COLUMN IF NOT EXISTS emoji varchar(8);
ALTER TABLE categories ADD COLUMN IF NOT EXISTS note text;

-- products ek kolonlar
ALTER TABLE products ADD COLUMN IF NOT EXISTS is_popular boolean NOT NULL DEFAULT false;
ALTER TABLE products ADD COLUMN IF NOT EXISTS portion_min integer;
ALTER TABLE products ADD COLUMN IF NOT EXISTS portion_max integer;
ALTER TABLE products ADD COLUMN IF NOT EXISTS portion_unit varchar(8);

-- izinleri garantile
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO yosun_user;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO yosun_user;
