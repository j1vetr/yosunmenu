import { Router } from "express";
import { db } from "../lib/db";
import {
  categoriesTable,
  categoryTranslationsTable,
  productsTable,
  productTranslationsTable,
  settingsTable,
  aiGenerationLogsTable,
} from "@workspace/db/schema";
import { requireAuth } from "../lib/auth";
import { eq, inArray, sql } from "drizzle-orm";
import { randomUUID } from "crypto";
import sharp from "sharp";
import { saveLocalFile, ensureUploadsDir, isReplitEnv } from "../lib/localFileStorage";
import { ObjectStorageService } from "../lib/objectStorage";

const router = Router();

/* ── helpers ──────────────────────────────────────────────────── */

function slugify(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/ğ/g, "g").replace(/ü/g, "u").replace(/ş/g, "s")
    .replace(/ı/g, "i").replace(/ö/g, "o").replace(/ç/g, "c")
    .replace(/â/g, "a").replace(/î/g, "i").replace(/û/g, "u")
    .replace(/&amp;/g, "and").replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100);
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&nbsp;/g, " ")
    .trim();
}

async function uniqueSlug(base: string, kind: "category" | "product"): Promise<string> {
  const tbl = kind === "category" ? categoriesTable : productsTable;
  let slug = base;
  let n = 0;
  while (true) {
    const rows = await db.select({ id: tbl.id }).from(tbl).where(eq(tbl.slug, slug)).limit(1);
    if (!rows.length) return slug;
    n++;
    slug = `${base}-${n}`;
  }
}

async function downloadAndStore(relUrl: string, sourceBase: string): Promise<string | null> {
  try {
    const url = relUrl.startsWith("http") ? relUrl : `${sourceBase}/${relUrl.replace(/^\//, "")}`;
    const resp = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; QRMenuImporter/1.0)" },
      signal: AbortSignal.timeout(20000),
    });
    if (!resp.ok) return null;
    const raw = Buffer.from(await resp.arrayBuffer());
    const optimized = await sharp(raw)
      .resize(1200, 1200, { fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer();
    const uuid = randomUUID();

    if (!isReplitEnv()) {
      await ensureUploadsDir();
      await saveLocalFile(uuid, optimized);
      return `/api/storage/local/${uuid}`;
    }

    const svc = new ObjectStorageService();
    const uploadUrl = await svc.getObjectEntityUploadURL();
    const put = await fetch(uploadUrl, {
      method: "PUT",
      body: optimized,
      headers: { "Content-Type": "image/jpeg" },
    });
    if (!put.ok) return null;
    const objectPath = await svc.trySetObjectEntityAclPolicy(uploadUrl, { visibility: "public" });
    return objectPath ?? null;
  } catch {
    return null;
  }
}

/* ── scrape helpers ───────────────────────────────────────────── */

interface RawCategory { id: number; name: string; imgUrl: string }
interface RawProduct {
  id: number; menu_name: string; menu_desc: string; menu_price: string;
  menu_images: string; menu_cat: number; cat_name: string;
}

async function fetchHtml(url: string): Promise<string> {
  const resp = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; QRMenuImporter/1.0)" },
    signal: AbortSignal.timeout(20000),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
  return resp.text();
}

function parseCategories(html: string): RawCategory[] {
  const re = /href="\/categories\?category=(\d+)"[^>]*>\s*<div[^>]*>\s*<img[^>]*src="([^"]+)"[^>]*alt="([^"]+)"/g;
  const results: RawCategory[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    results.push({ id: parseInt(m[1]), imgUrl: m[2], name: decodeEntities(m[3]) });
  }
  return results;
}

function parseProducts(html: string): RawProduct[] {
  const results: RawProduct[] = [];
  const seen = new Set<number>();
  const marker = "openProductModal(";
  let pos = 0;

  while (true) {
    const start = html.indexOf(marker, pos);
    if (start === -1) break;

    const jsonStart = start + marker.length;
    // Find matching closing brace by counting nesting — handles ")" inside JSON values
    let depth = 0;
    let jsonEnd = -1;
    for (let i = jsonStart; i < html.length; i++) {
      if (html[i] === "{") depth++;
      else if (html[i] === "}") {
        depth--;
        if (depth === 0) { jsonEnd = i + 1; break; }
      }
    }

    if (jsonEnd === -1) { pos = jsonStart; continue; }

    try {
      const raw = html.slice(jsonStart, jsonEnd)
        .replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&amp;/g, "&");
      const p = JSON.parse(raw) as RawProduct;
      if (!seen.has(p.id)) { seen.add(p.id); results.push(p); }
    } catch { /* malformed — skip */ }

    pos = jsonEnd;
  }

  return results;
}

function normalizeSourceUrl(raw: string): string {
  let url = raw.trim();
  if (!url.startsWith("http")) url = `https://${url}`;
  url = url.replace(/\/$/, "");
  return url;
}

/* ══════════════════════════════════════════════════════════════
   POST /import/scrape
   Body: { siteUrl?: string }
   ══════════════════════════════════════════════════════════════ */

router.post("/import/scrape", requireAuth, async (req, res): Promise<void> => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  type EventPayload =
    | { type: "log"; msg: string }
    | { type: "progress"; done: number; total: number; label: string }
    | { type: "done"; categories: number; products: number; errors: string[] }
    | { type: "error"; msg: string };

  const send = (payload: EventPayload) => {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  const errors: string[] = [];
  let catCount = 0;
  let prodCount = 0;

  try {
    const rawUrl: string = req.body?.siteUrl || "https://yoros.dijita.com.tr";
    const SOURCE = normalizeSourceUrl(rawUrl);
    send({ type: "log", msg: `Kaynak: ${SOURCE}` });

    /* 1. Fetch & parse categories */
    send({ type: "log", msg: "Kategoriler çekiliyor…" });
    const catHtml = await fetchHtml(`${SOURCE}/categories`);
    const rawCats = parseCategories(catHtml);
    if (!rawCats.length) {
      send({ type: "error", msg: "Kategori bulunamadı. URL yapısı uyumsuz olabilir." });
      res.end(); return;
    }
    send({ type: "log", msg: `${rawCats.length} kategori bulundu.` });

    /* 2. Fetch all category product pages */
    send({ type: "log", msg: "Her kategorinin ürünleri çekiliyor…" });
    // Dijita sitelerinde her kategori sayfası TÜM ürünleri içerir (JS ile filtreler).
    // Her ürünün menu_cat alanı her zaman ürünün kendi gerçek kategorisini gösterir —
    // sayfa bağlamına göre değişmez. Bu nedenle menu_cat'e güvenerek atama yapıyoruz.
    const allProducts = new Map<number, RawProduct>();

    for (let i = 0; i < rawCats.length; i++) {
      const cat = rawCats[i];
      send({ type: "progress", done: i, total: rawCats.length, label: `Kategori: ${cat.name}` });
      try {
        const html = await fetchHtml(`${SOURCE}/categories?category=${cat.id}`);
        const prods = parseProducts(html);
        // menu_cat doğru kategoriye işaret ettiği için sadece deduplikasyon yapıyoruz
        for (const p of prods) { allProducts.set(p.id, p); }
        // Bu sayfada kaç tane bu kategoriye ait ürün var?
        const ownProds = prods.filter(p => p.menu_cat === cat.id);
        send({ type: "log", msg: `  ${cat.name}: ${ownProds.length} ürün (sayfada toplam ${prods.length})` });
      } catch (e) {
        errors.push(`Kategori ${cat.id} çekilemedi: ${String(e)}`);
        send({ type: "log", msg: `  ❌ ${cat.name}: çekilemedi` });
      }
    }
    send({ type: "progress", done: rawCats.length, total: rawCats.length, label: "Ürünler çekildi" });
    send({ type: "log", msg: `Toplam ${allProducts.size} ürün bulundu.` });

    /* 3. Kategori görselleri */
    send({ type: "log", msg: "Kategori görselleri indiriliyor…" });
    const catImageMap = new Map<number, string>();
    for (let i = 0; i < rawCats.length; i++) {
      const cat = rawCats[i];
      send({ type: "progress", done: i, total: rawCats.length, label: `Görsel: ${cat.name}` });
      const url = await downloadAndStore(cat.imgUrl, SOURCE);
      if (url) catImageMap.set(cat.id, url);
      else errors.push(`Kategori görseli indirilemedi: ${cat.name}`);
    }

    /* 4. Ürün görselleri */
    send({ type: "log", msg: "Ürün görselleri indiriliyor…" });
    const prodList = [...allProducts.values()];
    const prodImageMap = new Map<number, string>();
    for (let i = 0; i < prodList.length; i++) {
      const p = prodList[i];
      send({ type: "progress", done: i, total: prodList.length, label: `Görsel: ${p.menu_name}` });
      if (p.menu_images) {
        const url = await downloadAndStore(p.menu_images, SOURCE);
        if (url) prodImageMap.set(p.id, url);
      }
    }
    send({ type: "progress", done: prodList.length, total: prodList.length, label: "Görseller tamamlandı" });

    /* 5. Kategorileri DB'ye yaz */
    send({ type: "log", msg: "Kategoriler veritabanına yazılıyor…" });
    const catIdMap = new Map<number, number>();

    for (let i = 0; i < rawCats.length; i++) {
      const cat = rawCats[i];
      const baseSlug = slugify(cat.name) || `kategori-${cat.id}`;
      try {
        const existingBySlug = await db.select({ id: categoriesTable.id })
          .from(categoriesTable).where(eq(categoriesTable.slug, baseSlug)).limit(1);

        if (existingBySlug.length) {
          send({ type: "log", msg: `  ⏭ Atlıyor (mevcut): ${cat.name}` });
          catIdMap.set(cat.id, existingBySlug[0].id);
          continue;
        }

        const slug = await uniqueSlug(baseSlug, "category");
        const [created] = await db.insert(categoriesTable)
          .values({ slug, imageUrl: catImageMap.get(cat.id) ?? null, sortOrder: i, isActive: true })
          .returning();

        await db.insert(categoryTranslationsTable).values({ categoryId: created.id, languageCode: "tr", name: cat.name });
        catIdMap.set(cat.id, created.id);
        catCount++;
        send({ type: "log", msg: `  ✓ ${cat.name}` });
      } catch (e) {
        errors.push(`Kategori eklenemedi (${cat.name}): ${String(e)}`);
        send({ type: "log", msg: `  ❌ ${cat.name}: ${String(e)}` });
      }
    }

    /* 6. Ürünleri DB'ye yaz */
    send({ type: "log", msg: "Ürünler veritabanına yazılıyor…" });
    let pi = 0;
    for (const p of prodList) {
      const newCatId = catIdMap.get(p.menu_cat);
      if (!newCatId) { errors.push(`Ürün kategorisi bulunamadı (${p.menu_name})`); continue; }

      const baseSlug = slugify(p.menu_name) || `urun-${p.id}`;
      const price = parseFloat(p.menu_price) || 0;
      try {
        const existingBySlug = await db.select({ id: productsTable.id })
          .from(productsTable).where(eq(productsTable.slug, baseSlug)).limit(1);

        if (existingBySlug.length) {
          send({ type: "log", msg: `  ⏭ Atlıyor (mevcut): ${p.menu_name}` });
          continue;
        }

        const slug = await uniqueSlug(baseSlug, "product");
        const [created] = await db.insert(productsTable)
          .values({ categoryId: newCatId, slug, price, currency: "TRY", isActive: true, sortOrder: pi, imageUrl: prodImageMap.get(p.id) ?? null })
          .returning();

        await db.insert(productTranslationsTable).values({
          productId: created.id, languageCode: "tr",
          name: decodeEntities(p.menu_name),
          description: decodeEntities(p.menu_desc || "") || null,
        });

        prodCount++;
        pi++;
        send({ type: "progress", done: pi, total: prodList.length, label: p.menu_name });
      } catch (e) {
        errors.push(`Ürün eklenemedi (${p.menu_name}): ${String(e)}`);
        send({ type: "log", msg: `  ❌ ${p.menu_name}: ${String(e)}` });
      }
    }

    /* 7. İkinci geçiş — eksik ürünleri kontrol et */
    send({ type: "log", msg: "\n🔍 İkinci geçiş: eksik ürünler kontrol ediliyor…" });
    let retryCount = 0;

    for (const cat of rawCats) {
      const newCatId = catIdMap.get(cat.id);
      if (!newCatId) continue;

      try {
        const html = await fetchHtml(`${SOURCE}/categories?category=${cat.id}`);
        const prods = parseProducts(html);

        for (const p of prods) {
          const baseSlug = slugify(p.menu_name) || `urun-${p.id}`;
          const existing = await db.select({ id: productsTable.id })
            .from(productsTable).where(eq(productsTable.slug, baseSlug)).limit(1);
          if (existing.length) continue; // already inserted

          // Bu ürün ilk geçişte atlanmış — şimdi ekle
          const price = parseFloat(p.menu_price) || 0;
          try {
            const slug = await uniqueSlug(baseSlug, "product");
            const imageUrl = p.menu_images ? await downloadAndStore(p.menu_images, SOURCE) : null;
            const [created] = await db.insert(productsTable)
              .values({ categoryId: newCatId, slug, price, currency: "TRY", isActive: true, sortOrder: 999, imageUrl })
              .returning();
            await db.insert(productTranslationsTable).values({
              productId: created.id, languageCode: "tr",
              name: decodeEntities(p.menu_name),
              description: decodeEntities(p.menu_desc || "") || null,
            });
            retryCount++;
            prodCount++;
            send({ type: "log", msg: `  ✓ (eksikti) ${cat.name} → ${p.menu_name}` });
          } catch (e) {
            errors.push(`İkinci geçiş eklenemedi (${p.menu_name}): ${String(e)}`);
          }
        }
      } catch { /* category page unreachable — skip */ }
    }

    if (retryCount > 0) {
      send({ type: "log", msg: `  +${retryCount} eksik ürün ikinci geçişte eklendi.` });
    } else {
      send({ type: "log", msg: "  Eksik ürün yok, her şey tamam." });
    }

    send({ type: "log", msg: `\n✅ Tamamlandı: ${catCount} kategori, ${prodCount} ürün eklendi.` });
    send({ type: "done", categories: catCount, products: prodCount, errors });
  } catch (e) {
    send({ type: "error", msg: String(e) });
  }

  res.end();
});

/* ══════════════════════════════════════════════════════════════
   POST /import/ai-enrich
   Toplu AI zenginleştirme: eksik dil çevirisi + besin değerleri
   ══════════════════════════════════════════════════════════════ */

router.post("/import/ai-enrich", requireAuth, async (req, res): Promise<void> => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  type EventPayload =
    | { type: "log"; msg: string }
    | { type: "progress"; done: number; total: number; label: string }
    | { type: "done"; enriched: number; errors: string[] }
    | { type: "error"; msg: string };

  const send = (payload: EventPayload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
  const errors: string[] = [];

  try {
    /* API key */
    const [settings] = await db.select().from(settingsTable).limit(1);
    const apiKey = settings?.openAiKey || process.env.OPENAI_API_KEY;
    if (!apiKey) {
      send({ type: "error", msg: "OpenAI API anahtarı ayarlanmamış. Önce Ayarlar sayfasından ekleyin." });
      res.end(); return;
    }

    /* Determine which languages to enrich from body (default all) */
    const targetLangs: string[] = req.body?.languages?.length
      ? req.body.languages
      : ["en", "ru", "ar"];
    const enrichNutrition: boolean = req.body?.nutrition !== false;

    send({ type: "log", msg: `Hedef diller: ${targetLangs.join(", ")}${enrichNutrition ? " + besin değerleri" : ""}` });

    /* Find products that need enrichment */
    const allProducts = await db
      .select({
        id: productsTable.id,
        slug: productsTable.slug,
        price: productsTable.price,
        calories: productsTable.calories,
        nutritionFacts: productsTable.nutritionFacts,
        allergens: productsTable.allergens,
      })
      .from(productsTable)
      .where(eq(productsTable.isActive, true));

    /* Get all existing translations for these products */
    const productIds = allProducts.map((p) => p.id);
    const allTranslations = productIds.length
      ? await db.select().from(productTranslationsTable)
          .where(inArray(productTranslationsTable.productId, productIds))
      : [];

    const transByProduct = new Map<number, Map<string, typeof allTranslations[0]>>();
    for (const t of allTranslations) {
      if (!transByProduct.has(t.productId)) transByProduct.set(t.productId, new Map());
      transByProduct.get(t.productId)!.set(t.languageCode, t);
    }

    /* Filter to only products that need work */
    const toEnrich = allProducts.filter((p) => {
      const langs = transByProduct.get(p.id) ?? new Map();
      const missingLang = targetLangs.some((l) => !langs.has(l));
      const missingNutrition = enrichNutrition && (!p.calories || !p.nutritionFacts || Object.keys(p.nutritionFacts as object || {}).length === 0);
      return missingLang || missingNutrition;
    });

    if (!toEnrich.length) {
      send({ type: "log", msg: "Tüm ürünler zaten zenginleştirilmiş — yapacak iş yok." });
      send({ type: "done", enriched: 0, errors: [] });
      res.end(); return;
    }

    send({ type: "log", msg: `${toEnrich.length} ürün zenginleştirilecek…` });

    let enriched = 0;

    const langNames: Record<string, string> = { tr: "Turkish", en: "English", ru: "Russian", ar: "Arabic" };

    for (let i = 0; i < toEnrich.length; i++) {
      const product = toEnrich[i];
      const langs = transByProduct.get(product.id) ?? new Map();
      const trName = langs.get("tr")?.name ?? product.slug;
      const trDesc = langs.get("tr")?.description ?? "";
      const catRow = await db
        .select({ name: categoryTranslationsTable.name })
        .from(categoryTranslationsTable)
        .innerJoin(productsTable, eq(productsTable.categoryId, categoryTranslationsTable.categoryId))
        .where(eq(productsTable.id, product.id))
        .where(eq(categoryTranslationsTable.languageCode, "tr"))
        .limit(1);
      const catName = catRow[0]?.name ?? "";

      const missingLangs = targetLangs.filter((l) => !langs.has(l));
      const needsNutrition = enrichNutrition && (!product.calories || !product.nutritionFacts || Object.keys(product.nutritionFacts as object || {}).length === 0);

      send({ type: "progress", done: i, total: toEnrich.length, label: trName });
      send({ type: "log", msg: `  [${i + 1}/${toEnrich.length}] ${trName}` });

      /* Build prompt */
      const langSection = missingLangs.length
        ? `Generate translations for these languages: ${missingLangs.map((l) => `${l} (${langNames[l] ?? l})`).join(", ")}.`
        : "";
      const nutritionSection = needsNutrition ? "Also estimate nutritional values." : "";

      const prompt = `You are a restaurant menu data enricher for an authentic everyday Turkish restaurant (büfe/lokanta/kebapçı).

Product: "${trName}" (Category: "${catName}", Price: ${product.price} TRY)
${trDesc ? `Turkish description: "${trDesc}"` : ""}

${langSection}
${nutritionSection}

Respond ONLY with valid JSON:
{
  ${missingLangs.length ? `"translations": {
    ${missingLangs.map((l) => `"${l}": {
      "name": "...",
      "description": "...",
      "ingredients": "...",
      "allergenNote": "..."
    }`).join(",\n    ")}
  }${needsNutrition ? "," : ""}` : ""}
  ${needsNutrition ? `"calories": 350,
  "nutritionFacts": { "energy": 1465, "protein": 18, "carbs": 42, "fat": 12 },
  "allergens": ["gluten", "dairy"]` : ""}
}

Translation rules:
- name (en): use the internationally recognised English name (Doner Kebab, not Meat Döner; Meatball, not Köfte)
- name (ru): use standard Russian name if known, else natural transliteration (Донер-кебаб)
- name (ar): use Arabic name if known for Turkish food, else transliterate
- description: honest, max 50 words, no fine-dining language
- ingredients: comma-separated main ingredients in that language
- allergenNote: brief allergen sentence in that language (empty string if none)
${needsNutrition ? `
Nutrition rules:
- calories: total kcal for a standard portion
- energy: kJ (= kcal × 4.184)
- protein/carbs/fat: grams
- allergens: array from [gluten, dairy, eggs, nuts, sesame, soy, fish, shellfish] (empty if none)` : ""}`;

      let success = false;
      let tokensUsed: number | undefined;

      try {
        const aiResp = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({
            model: "gpt-4o-mini",
            messages: [{ role: "user", content: prompt }],
            temperature: 0.4,
            response_format: { type: "json_object" },
          }),
          signal: AbortSignal.timeout(30000),
        });

        if (!aiResp.ok) {
          const err = await aiResp.text();
          throw new Error(`OpenAI ${aiResp.status}: ${err.slice(0, 200)}`);
        }

        const data = await aiResp.json() as { choices?: Array<{ message?: { content?: string } }>; usage?: { total_tokens?: number } };
        tokensUsed = data.usage?.total_tokens;
        const content = data.choices?.[0]?.message?.content ?? "{}";
        const parsed = JSON.parse(content) as {
          translations?: Record<string, { name?: string; description?: string; ingredients?: string; allergenNote?: string }>;
          calories?: number;
          nutritionFacts?: { energy?: number; protein?: number; carbs?: number; fat?: number };
          allergens?: string[];
        };

        /* Upsert translations */
        if (parsed.translations) {
          for (const [lang, t] of Object.entries(parsed.translations)) {
            if (!t.name) continue;
            const existing = langs.get(lang);
            if (existing) {
              await db.update(productTranslationsTable)
                .set({ name: t.name, description: t.description ?? null, ingredients: t.ingredients ?? null, allergenNote: t.allergenNote ?? null })
                .where(eq(productTranslationsTable.id, existing.id));
            } else {
              await db.insert(productTranslationsTable).values({
                productId: product.id, languageCode: lang,
                name: t.name, description: t.description ?? null,
                ingredients: t.ingredients ?? null, allergenNote: t.allergenNote ?? null,
              }).onConflictDoNothing();
            }
          }
        }

        /* Update nutrition */
        if (needsNutrition && (parsed.calories || parsed.nutritionFacts)) {
          await db.update(productsTable).set({
            calories: parsed.calories ?? null,
            nutritionFacts: parsed.nutritionFacts ?? {},
            allergens: parsed.allergens ?? [],
          }).where(eq(productsTable.id, product.id));
        }

        success = true;
        enriched++;
        send({ type: "log", msg: `    ✓ ${missingLangs.join("+")}${needsNutrition ? " +besin" : ""}` });

        /* Rate limit: 150ms between calls */
        await new Promise((r) => setTimeout(r, 150));
      } catch (e) {
        errors.push(`${trName}: ${String(e)}`);
        send({ type: "log", msg: `    ❌ ${String(e).slice(0, 80)}` });
      }

      await db.insert(aiGenerationLogsTable).values({
        productId: product.id, productName: trName, model: "gpt-4o-mini",
        tokensUsed: tokensUsed ?? null, success,
        errorMessage: success ? null : (errors[errors.length - 1] ?? null),
      }).catch(() => {});
    }

    send({ type: "progress", done: toEnrich.length, total: toEnrich.length, label: "Tamamlandı" });
    send({ type: "log", msg: `\n✅ ${enriched} ürün zenginleştirildi.` });
    send({ type: "done", enriched, errors });
  } catch (e) {
    send({ type: "error", msg: String(e) });
  }

  res.end();
});

/* ══════════════════════════════════════════════════════════════
   GET /import/enrich-status  — quick counts for the UI
   ══════════════════════════════════════════════════════════════ */

router.get("/import/enrich-status", requireAuth, async (req, res): Promise<void> => {
  try {
    const total = await db.select({ count: sql<number>`count(*)` }).from(productsTable)
      .where(eq(productsTable.isActive, true));
    const totalCount = Number(total[0]?.count ?? 0);

    /* count products with EN translation */
    const withEn = await db.select({ count: sql<number>`count(distinct product_id)` })
      .from(productTranslationsTable)
      .where(eq(productTranslationsTable.languageCode, "en"));
    const withRu = await db.select({ count: sql<number>`count(distinct product_id)` })
      .from(productTranslationsTable)
      .where(eq(productTranslationsTable.languageCode, "ru"));
    const withAr = await db.select({ count: sql<number>`count(distinct product_id)` })
      .from(productTranslationsTable)
      .where(eq(productTranslationsTable.languageCode, "ar"));

    res.json({
      total: totalCount,
      withEn: Number(withEn[0]?.count ?? 0),
      withRu: Number(withRu[0]?.count ?? 0),
      withAr: Number(withAr[0]?.count ?? 0),
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

export default router;
