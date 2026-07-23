import { useState, useEffect, useRef } from "react";
import { apiFetch } from "@/lib/api";
import { normalizeAllergenKey } from "@/lib/allergens";
import { useToast } from "@/hooks/use-toast";
import {
  Plus, Pencil, Trash2, X, GripVertical, Sparkles, Upload,
  ImageIcon, Eye, Image, ChevronDown, ChevronUp,
  ListPlus, Images, CheckSquare2, Square, Loader2, CheckCircle2, XCircle, Search, RefreshCw, Scale,
} from "lucide-react";
import {
  DndContext, closestCenter, PointerSensor,
  useSensor, useSensors, DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext, verticalListSortingStrategy,
  useSortable, arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

/* ─── Types ─────────────────────────────────────────────────────── */
interface Translation {
  languageCode: string;
  name: string;
  description?: string;
  ingredients?: string;
  allergenNote?: string;
  specialNote?: string;
}

interface NutritionFacts {
  energy?: number;
  protein?: number;
  carbs?: number;
  fat?: number;
}

interface Product {
  id: number;
  categoryId: number;
  slug: string;
  price: number;
  currency?: string;
  imageUrl?: string;
  isActive: boolean;
  isPopular: boolean;
  sortOrder: number;
  portionMin?: number;
  portionMax?: number;
  portionUnit?: string;
  calories?: number;
  allergens?: string[];
  nutritionFacts?: NutritionFacts;
  translations: Translation[];
}

interface Category {
  id: number;
  slug: string;
  translations: Translation[];
}

interface Language {
  id: number;
  code: string;
  name: string;
}

/* ─── Constants ─────────────────────────────────────────────────── */
const LANG_FLAGS: Record<string, string> = { tr: "🇹🇷", en: "🇬🇧", ru: "🇷🇺", ar: "🇸🇦" };

const ALLERGEN_CHIPS = [
  { key: "gluten",       label: "Gluten",      icon: "🌾" },
  { key: "süt",          label: "Süt",          icon: "🥛" },
  { key: "yumurta",      label: "Yumurta",      icon: "🥚" },
  { key: "balık",        label: "Balık",        icon: "🐟" },
  { key: "kabuklu",      label: "Kabuklu",      icon: "🦐" },
  { key: "fındık",       label: "Fındık",       icon: "🌰" },
  { key: "yer fıstığı",  label: "Yer Fıstığı",  icon: "🥜" },
  { key: "soya",         label: "Soya",         icon: "🫘" },
  { key: "kereviz",      label: "Kereviz",      icon: "🌿" },
  { key: "hardal",       label: "Hardal",       icon: "🌻" },
  { key: "susam",        label: "Susam",        icon: "🫙" },
  { key: "lupin",        label: "Lupin",        icon: "🌸" },
  { key: "yumuşakça",    label: "Yumuşakça",    icon: "🦑" },
  { key: "sülfitler",    label: "Sülfitler",    icon: "🧪" },
];

/* ─── Image utilities ────────────────────────────────────────────── */

/** Draw an HTMLImageElement onto canvas, then iteratively reduce JPEG quality
 *  until blob is ≤ targetBytes or quality reaches 0.50. */
async function compressToTarget(
  img: HTMLImageElement,
  maxWidth: number,
  targetBytes: number
): Promise<Blob> {
  const scale = Math.min(1, maxWidth / img.width);
  const canvas = document.createElement("canvas");
  canvas.width  = Math.round(img.width  * scale);
  canvas.height = Math.round(img.height * scale);
  canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height);

  const blobAt = (q: number) =>
    new Promise<Blob>((res, rej) =>
      canvas.toBlob((b) => (b ? res(b) : rej(new Error("Canvas blob boş"))), "image/jpeg", q)
    );

  let quality = 0.85;
  const MIN_QUALITY = 0.50;
  const STEP = 0.10;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const blob = await blobAt(quality);
    if (blob.size <= targetBytes || quality <= MIN_QUALITY) return blob;
    quality = Math.max(MIN_QUALITY, quality - STEP);
  }
}

/** Compress a File (user upload) to ≤200 KB JPEG, max 1200 px wide. */
async function compressImage(
  file: File,
  maxWidth = 1200,
  targetBytes = 200 * 1024
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const img = new globalThis.Image();
    const url = URL.createObjectURL(file);
    img.onload  = () => { URL.revokeObjectURL(url); compressToTarget(img, maxWidth, targetBytes).then(resolve).catch(reject); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Görsel yüklenemedi")); };
    img.src = url;
  });
}

/** Optimize an image URL server-side (CORS-free) via the API. Returns the new serving URL. */
async function optimizeImageUrl(url: string): Promise<{ servingUrl: string; size: number }> {
  // Resolve relative paths (e.g. /api/storage/objects/...) to absolute so the
  // server can fetch them without receiving an invalid URL error.
  const absoluteUrl = url.startsWith("/") ? `${window.location.origin}${url}` : url;
  return apiFetch<{ servingUrl: string; size: number }>("/storage/optimize-image", {
    method: "POST",
    body: JSON.stringify({ url: absoluteUrl }),
  });
}

/** Compress a base64 data-URL (AI image) through the same pipeline. */
async function compressDataUrl(
  dataUrl: string,
  maxWidth = 1200,
  targetBytes = 200 * 1024
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const img = new globalThis.Image();
    img.onload  = () => compressToTarget(img, maxWidth, targetBytes).then(resolve).catch(reject);
    img.onerror = () => reject(new Error("AI görseli yüklenemedi"));
    img.src = dataUrl;
  });
}

/** Upload a pre-compressed Blob directly (no extra compression). */
async function uploadBlob(blob: Blob, filename: string): Promise<string> {
  const { uploadURL, objectPath } = await apiFetch<{ uploadURL: string; objectPath: string }>(
    "/storage/uploads/request-url",
    { method: "POST", body: JSON.stringify({ name: filename, size: blob.size, contentType: "image/jpeg" }) }
  );
  await fetch(uploadURL, { method: "PUT", headers: { "Content-Type": "image/jpeg" }, body: blob });
  const { servingUrl } = await apiFetch<{ servingUrl: string }>("/storage/uploads/confirm", {
    method: "POST", body: JSON.stringify({ objectPath }),
  });
  return servingUrl;
}

/** Compress a user-selected File then upload. */
async function uploadImage(file: File): Promise<string> {
  const blob = await compressImage(file);
  return uploadBlob(blob, file.name.replace(/\.[^.]+$/, ".jpg"));
}

function formatBytes(bytes: number): string {
  if (bytes < 1024)          return `${bytes} B`;
  if (bytes < 1024 * 1024)   return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/* ─── Shared style constants ──────────────────────────────────── */
const INPUT = "w-full bg-neutral-800 border border-neutral-700 text-white rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-white";

/* ─── BulkAddModal ────────────────────────────────────────────── */
interface BulkRow {
  id: string;
  name: string;
  price: string;
  categoryId: number;
  status: "idle" | "ai" | "saving" | "done" | "error";
  error?: string;
}

type BulkPhase = "idle" | "ai" | "saving" | "done";

function BulkAddModal({
  categories,
  onClose,
  onDone,
}: {
  categories: Category[];
  onClose: () => void;
  onDone: () => void;
}) {
  const { toast } = useToast();
  const defaultCat = categories[0]?.id ?? 0;

  const newRow = (): BulkRow => ({
    id: crypto.randomUUID(),
    name: "",
    price: "",
    categoryId: defaultCat,
    status: "idle",
  });

  const [rows, setRows] = useState<BulkRow[]>([newRow(), newRow(), newRow()]);
  const [phase, setPhase]       = useState<BulkPhase>("idle");
  const [aiProgress, setAiProg] = useState({ done: 0, total: 0 });
  const [svProgress, setSvProg] = useState({ done: 0, total: 0 });
  const [pasteText,  setPasteText]  = useState("");
  const [showImport, setShowImport] = useState(false);

  function updateRow(id: string, patch: Partial<BulkRow>) {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }

  /** Parse pasted text: "Ad,Fiyat,Kategori" (comma, semicolon or tab) per line */
  function parsePaste() {
    const lines = pasteText.split("\n").map((l) => l.trim()).filter(Boolean);
    if (!lines.length) return;
    const parsed: BulkRow[] = lines.map((line) => {
      const sep   = line.includes("\t") ? "\t" : line.includes(";") ? ";" : ",";
      const parts = line.split(sep).map((p) => p.trim());
      const name  = parts[0] ?? "";
      const price = parts[1]?.replace(/[^0-9.]/g, "") ?? "";
      const catRaw = (parts[2] ?? "").toLowerCase();
      const matched = categories.find((c) =>
        c.translations.some((t) => t.languageCode === "tr" && t.name.toLowerCase().includes(catRaw))
      );
      return { id: crypto.randomUUID(), name, price, categoryId: matched?.id ?? defaultCat, status: "idle" as const };
    }).filter((r) => r.name);
    if (!parsed.length) { toast({ title: "Geçerli satır bulunamadı", variant: "destructive" }); return; }
    setRows((prev) => {
      // Replace empty placeholder rows, then append parsed
      const nonEmpty = prev.filter((r) => r.name.trim() || r.price.trim());
      return [...nonEmpty, ...parsed];
    });
    setPasteText("");
    setShowImport(false);
    toast({ title: `${parsed.length} satır aktarıldı` });
  }

  const validRows = rows.filter((r) => r.name.trim() && parseFloat(r.price) > 0);

  async function handleRun() {
    if (!validRows.length) {
      toast({ title: "En az 1 geçerli satır gerekli (ad + fiyat)", variant: "destructive" });
      return;
    }

    // ── Phase 1: AI generation ──────────────────────────────────
    setPhase("ai");
    setAiProg({ done: 0, total: validRows.length });
    const aiData: Record<string, Record<string, unknown>> = {};

    for (let i = 0; i < validRows.length; i++) {
      const row = validRows[i];
      updateRow(row.id, { status: "ai" });
      try {
        const cat     = categories.find((c) => c.id === row.categoryId);
        const catName = cat?.translations.find((t) => t.languageCode === "tr")?.name;
        const result  = await apiFetch<Record<string, unknown>>("/ai/generate", {
          method: "POST",
          body: JSON.stringify({ productName: row.name, category: catName }),
        });
        aiData[row.id] = result;
        updateRow(row.id, { status: "idle" });
      } catch {
        updateRow(row.id, { status: "error", error: "AI hatası" });
      }
      setAiProg({ done: i + 1, total: validRows.length });
    }

    // ── Phase 2: Save ──────────────────────────────────────────
    setPhase("saving");
    setSvProg({ done: 0, total: validRows.length });

    for (let i = 0; i < validRows.length; i++) {
      const row = validRows[i];
      if (row.status === "error") { setSvProg({ done: i + 1, total: validRows.length }); continue; }
      updateRow(row.id, { status: "saving" });
      try {
        const ai   = aiData[row.id] as { translations?: Record<string, { name: string; description: string; ingredients: string; allergenNote: string }>; allergens?: string[]; nutritionFacts?: object; calories?: number; portionMin?: number; portionMax?: number; portionUnit?: string } | undefined;
        const base = row.name.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
        const slug = `${base}-${Date.now()}`;
        await apiFetch("/products", {
          method: "POST",
          body: JSON.stringify({
            slug,
            categoryId: row.categoryId,
            price: parseFloat(row.price),
            isActive: true,
            calories: ai?.calories,
            portionMin: ai?.portionMin ?? null,
            portionMax: ai?.portionMax ?? null,
            portionUnit: ai?.portionUnit ?? null,
            allergens: ai?.allergens ?? [],
            nutritionFacts: ai?.nutritionFacts ?? {},
            translations: ai?.translations
              ? Object.entries(ai.translations).map(([code, t]) => ({
                  languageCode: code, name: t.name, description: t.description,
                  ingredients: t.ingredients, allergenNote: t.allergenNote,
                }))
              : [{ languageCode: "tr", name: row.name }],
          }),
        });
        updateRow(row.id, { status: "done" });
      } catch {
        updateRow(row.id, { status: "error", error: "Kaydetme hatası" });
      }
      setSvProg({ done: i + 1, total: validRows.length });
    }

    setPhase("done");
    toast({ title: "Toplu ekleme tamamlandı ✓" });
    onDone();
  }

  const running = phase === "ai" || phase === "saving";

  const statusIcon = (s: BulkRow["status"]) => {
    if (s === "ai" || s === "saving") return <Loader2 className="w-3.5 h-3.5 animate-spin text-amber-400" />;
    if (s === "done")  return <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />;
    if (s === "error") return <XCircle className="w-3.5 h-3.5 text-red-400" />;
    return null;
  };

  return (
    <div className="fixed inset-0 bg-black/80 flex items-end sm:items-center justify-center z-50 p-0 sm:p-4">
      <div className="bg-neutral-900 border border-neutral-800 rounded-t-2xl sm:rounded-2xl w-full max-w-2xl max-h-[94vh] flex flex-col">

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-neutral-800 shrink-0">
          <div>
            <h2 className="text-white font-semibold flex items-center gap-2"><ListPlus className="w-4 h-4 text-amber-400" /> Toplu Ürün Ekle</h2>
            <p className="text-xs text-neutral-500 mt-0.5">Her satır için AI otomatik içerik üretir ve kaydeder</p>
          </div>
          <button onClick={onClose} disabled={running} className="text-neutral-400 hover:text-white disabled:opacity-30 transition-colors p-1">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Table */}
        <div className="overflow-y-auto flex-1 px-6 py-4">

          {/* ── Metin ile içe aktar ── */}
          {!running && (
            <div className="mb-4">
              <button
                onClick={() => setShowImport((v) => !v)}
                className="flex items-center gap-1.5 text-xs text-neutral-500 hover:text-amber-400 transition-colors"
              >
                <span className="text-amber-600">↓</span>
                {showImport ? "Metin aktarımını kapat" : "Metin ile içe aktar  (Ad,Fiyat,Kategori)"}
              </button>

              {showImport && (
                <div className="mt-2 space-y-2">
                  <textarea
                    value={pasteText}
                    onChange={(e) => setPasteText(e.target.value)}
                    rows={5}
                    placeholder={"Hamburger,250,Yiyecekler\nIzgara Tavuk,180,Ana Yemekler\nTiramisu,120,Tatlılar"}
                    className="w-full bg-neutral-800 border border-neutral-700 text-white rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:border-amber-600 resize-none placeholder:text-neutral-600"
                  />
                  <div className="flex items-center gap-2">
                    <p className="text-[10px] text-neutral-600 flex-1">
                      Her satır: <span className="text-neutral-400">Ad, Fiyat, Kategori</span> — virgül, noktalı virgül veya sekme ile ayrılabilir
                    </p>
                    <button
                      onClick={parsePaste}
                      disabled={!pasteText.trim()}
                      className="px-3 py-1.5 rounded-lg text-xs font-semibold disabled:opacity-30 transition-all"
                      style={{ background: "#C9A84C22", border: "1px solid #C9A84C55", color: "#C9A84C" }}
                    >
                      Satırlara Aktar
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          <div className="space-y-2">
            {/* Column headers */}
            <div className="grid grid-cols-[1fr_100px_140px_32px_32px] gap-2 text-[10px] text-neutral-500 uppercase tracking-widest px-1">
              <span>Ürün Adı *</span><span>Fiyat *</span><span>Kategori</span><span></span><span></span>
            </div>

            {rows.map((row) => (
              <div key={row.id} className="grid grid-cols-[1fr_100px_140px_32px_32px] gap-2 items-center">
                <input
                  value={row.name}
                  disabled={running}
                  onChange={(e) => updateRow(row.id, { name: e.target.value })}
                  placeholder="Ürün adı"
                  className={`${INPUT} disabled:opacity-50 ${row.status === "error" ? "border-red-700" : row.status === "done" ? "border-emerald-800" : ""}`}
                />
                <input
                  type="number"
                  value={row.price}
                  disabled={running}
                  onChange={(e) => updateRow(row.id, { price: e.target.value })}
                  placeholder="0"
                  className={`${INPUT} disabled:opacity-50 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none`}
                />
                <select
                  value={row.categoryId}
                  disabled={running}
                  onChange={(e) => updateRow(row.id, { categoryId: Number(e.target.value) })}
                  className={`${INPUT} disabled:opacity-50`}
                >
                  {categories.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.translations.find((t) => t.languageCode === "tr")?.name ?? c.slug}
                    </option>
                  ))}
                </select>
                <div className="flex items-center justify-center">{statusIcon(row.status)}</div>
                <button
                  onClick={() => setRows((prev) => prev.filter((r) => r.id !== row.id))}
                  disabled={running || rows.length <= 1}
                  className="text-neutral-600 hover:text-red-400 disabled:opacity-20 transition-colors"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            ))}
          </div>

          {!running && (
            <button
              onClick={() => setRows((prev) => [...prev, newRow()])}
              className="mt-3 flex items-center gap-1.5 text-xs text-neutral-500 hover:text-white transition-colors"
            >
              <Plus className="w-3.5 h-3.5" /> Satır Ekle
            </button>
          )}
        </div>

        {/* Progress */}
        {running && (
          <div className="px-6 py-3 border-t border-neutral-800 shrink-0 space-y-2">
            {phase === "ai" && (
              <div>
                <div className="flex justify-between text-xs text-neutral-400 mb-1">
                  <span className="flex items-center gap-1.5"><Sparkles className="w-3 h-3 text-amber-400" /> AI içerik üretiyor…</span>
                  <span>{aiProgress.done} / {aiProgress.total}</span>
                </div>
                <div className="h-1 bg-neutral-800 rounded-full overflow-hidden">
                  <div className="h-full bg-amber-500 rounded-full transition-all" style={{ width: `${(aiProgress.done / aiProgress.total) * 100}%` }} />
                </div>
              </div>
            )}
            {phase === "saving" && (
              <div>
                <div className="flex justify-between text-xs text-neutral-400 mb-1">
                  <span className="flex items-center gap-1.5"><Loader2 className="w-3 h-3 animate-spin" /> Kaydediliyor…</span>
                  <span>{svProgress.done} / {svProgress.total}</span>
                </div>
                <div className="h-1 bg-neutral-800 rounded-full overflow-hidden">
                  <div className="h-full bg-emerald-500 rounded-full transition-all" style={{ width: `${(svProgress.done / svProgress.total) * 100}%` }} />
                </div>
              </div>
            )}
          </div>
        )}

        {/* Footer */}
        <div className="flex gap-3 px-6 py-4 border-t border-neutral-800 shrink-0">
          <button
            onClick={onClose}
            disabled={running}
            className="flex-1 py-2.5 rounded-full border border-neutral-700 text-neutral-300 text-sm hover:border-white disabled:opacity-30 transition-colors"
          >
            {phase === "done" ? "Kapat" : "İptal"}
          </button>
          <button
            onClick={handleRun}
            disabled={running || validRows.length === 0}
            className="flex-1 py-2.5 rounded-full text-sm font-semibold disabled:opacity-40 transition-all flex items-center justify-center gap-2"
            style={{ background: "linear-gradient(135deg,#C9A84C1A,#C9A84C0D)", border: "1px solid #C9A84C66", color: "#C9A84C" }}
          >
            {running
              ? <><Loader2 className="w-4 h-4 animate-spin" /> İşleniyor…</>
              : <><Sparkles className="w-4 h-4" /> ✦ AI ile Üret &amp; Kaydet ({validRows.length})</>}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ─── BulkImageModal ──────────────────────────────────────────── */
interface ImageJob {
  productId: number;
  productName: string;
  categoryName?: string;
  hasImage: boolean;
  selected: boolean;
  status: "pending" | "generating" | "uploading" | "done" | "error";
  error?: string;
}

const IMAGE_STYLES = [
  { key: "restaurant",   label: "🍽️ Restoran",    desc: "Sıcak, doğal ortam" },
  { key: "professional", label: "📸 Profesyonel", desc: "Koyu fon, dramatik ışık" },
  { key: "rustic",       label: "🌿 Rustik",       desc: "Ahşap, güneş ışığı" },
  { key: "minimal",      label: "◾ Minimalist",    desc: "Sade, temiz" },
  { key: "outdoor",      label: "🌳 Doğa",         desc: "Bahçe, teras" },
] as const;

function BulkImageModal({
  products,
  categories,
  onClose,
  onDone,
}: {
  products: Product[];
  categories: Category[];
  onClose: () => void;
  onDone: () => void;
}) {
  const { toast } = useToast();

  const [jobs, setJobs] = useState<ImageJob[]>(() =>
    products.map((p) => ({
      productId: p.id,
      productName: p.translations.find((t) => t.languageCode === "tr")?.name ?? p.slug,
      categoryName: categories.find((c) => c.id === p.categoryId)?.translations.find((t) => t.languageCode === "tr")?.name,
      hasImage: !!p.imageUrl,
      selected: !p.imageUrl,
      status: "pending" as const,
    }))
  );
  const [style, setStyle]   = useState<string>("restaurant");
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });

  function toggleJob(id: number) {
    setJobs((prev) => prev.map((j) => (j.productId === id ? { ...j, selected: !j.selected } : j)));
  }
  function selectAll()   { setJobs((prev) => prev.map((j) => ({ ...j, selected: true  }))); }
  function selectNone()  { setJobs((prev) => prev.map((j) => ({ ...j, selected: false }))); }
  function selectNoImg() { setJobs((prev) => prev.map((j) => ({ ...j, selected: !j.hasImage }))); }

  function updateJob(id: number, patch: Partial<ImageJob>) {
    setJobs((prev) => prev.map((j) => (j.productId === id ? { ...j, ...patch } : j)));
  }

  const selectedJobs = jobs.filter((j) => j.selected);

  async function handleGenerate() {
    if (!selectedJobs.length) {
      toast({ title: "En az 1 ürün seçin", variant: "destructive" });
      return;
    }
    setRunning(true);
    setProgress({ done: 0, total: selectedJobs.length });

    for (let i = 0; i < selectedJobs.length; i++) {
      const job = selectedJobs[i];
      updateJob(job.productId, { status: "generating" });
      try {
        const result = await apiFetch<{ b64: string }>("/ai/generate-image", {
          method: "POST",
          body: JSON.stringify({
            productName: job.productName,
            productId:   job.productId,
            category:    job.categoryName,
            style,
          }),
        });

        updateJob(job.productId, { status: "uploading" });
        const blob       = await compressDataUrl(`data:image/jpeg;base64,${result.b64}`);
        const servingUrl = await uploadBlob(blob, "ai-image.jpg");

        await apiFetch(`/products/${job.productId}`, {
          method: "PATCH",
          body: JSON.stringify({ imageUrl: servingUrl }),
        });
        updateJob(job.productId, { status: "done" });
      } catch (err) {
        updateJob(job.productId, { status: "error", error: String(err).slice(0, 80) });
      }
      setProgress({ done: i + 1, total: selectedJobs.length });
    }

    setRunning(false);
    toast({ title: "Toplu görsel üretimi tamamlandı ✓" });
    onDone();
  }

  const jobStatusIcon = (s: ImageJob["status"]) => {
    if (s === "generating") return <span className="text-[9px] text-amber-400 font-bold animate-pulse">AI</span>;
    if (s === "uploading")  return <Loader2 className="w-3 h-3 animate-spin text-neutral-400" />;
    if (s === "done")       return <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />;
    if (s === "error")      return <XCircle className="w-3.5 h-3.5 text-red-400" />;
    return null;
  };

  return (
    <div className="fixed inset-0 bg-black/80 flex items-end sm:items-center justify-center z-50 p-0 sm:p-4">
      <div className="bg-neutral-900 border border-neutral-800 rounded-t-2xl sm:rounded-2xl w-full max-w-2xl max-h-[94vh] flex flex-col">

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-neutral-800 shrink-0">
          <div>
            <h2 className="text-white font-semibold flex items-center gap-2"><Images className="w-4 h-4 text-amber-400" /> Toplu Görsel Üret</h2>
            <p className="text-xs text-neutral-500 mt-0.5">{selectedJobs.length} ürün seçili · AI ile birer birer üretilir</p>
          </div>
          <button onClick={onClose} disabled={running} className="text-neutral-400 hover:text-white disabled:opacity-30 transition-colors p-1">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="overflow-y-auto flex-1 flex flex-col">
          {/* Style picker */}
          <div className="px-6 pt-4 pb-3 shrink-0">
            <p className="text-[10px] text-neutral-500 uppercase tracking-widest mb-2">Görsel Stili</p>
            <div className="grid grid-cols-5 gap-1.5">
              {IMAGE_STYLES.map(({ key, label, desc }) => (
                <button
                  key={key}
                  onClick={() => setStyle(key)}
                  disabled={running}
                  className={`px-2 py-2 rounded-lg border text-[11px] text-left transition-all disabled:opacity-40 ${
                    style === key
                      ? "border-amber-500/60 bg-amber-950/30 text-amber-400"
                      : "border-neutral-700 text-neutral-400 hover:border-neutral-500"
                  }`}
                >
                  <div className="font-medium leading-tight">{label}</div>
                  <div className="text-[9px] opacity-60 mt-0.5">{desc}</div>
                </button>
              ))}
            </div>
          </div>

          {/* Selection controls */}
          <div className="px-6 pb-2 flex items-center gap-3 shrink-0">
            <span className="text-xs text-neutral-500">Seç:</span>
            <button onClick={selectAll}   disabled={running} className="text-xs text-neutral-400 hover:text-white transition-colors disabled:opacity-30">Tümü</button>
            <button onClick={selectNone}  disabled={running} className="text-xs text-neutral-400 hover:text-white transition-colors disabled:opacity-30">Hiçbiri</button>
            <button onClick={selectNoImg} disabled={running} className="text-xs text-neutral-400 hover:text-white transition-colors disabled:opacity-30">Görselsizler</button>
          </div>

          {/* Product list */}
          <div className="px-6 pb-4 space-y-1 flex-1">
            {jobs.map((job) => (
              <button
                key={job.productId}
                onClick={() => !running && toggleJob(job.productId)}
                disabled={running}
                className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg border text-left transition-all disabled:cursor-default ${
                  job.selected
                    ? "border-amber-800/50 bg-amber-950/20"
                    : "border-neutral-800 bg-neutral-800/30 hover:border-neutral-700"
                }`}
              >
                <div className="shrink-0 text-neutral-500">
                  {job.selected
                    ? <CheckSquare2 className="w-4 h-4 text-amber-400" />
                    : <Square className="w-4 h-4" />}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-white truncate">{job.productName}</div>
                  <div className="text-[10px] text-neutral-500">{job.categoryName ?? "—"}{job.hasImage ? " · görseli var" : " · görsel yok"}</div>
                </div>
                <div className="shrink-0 w-5 flex items-center justify-center">
                  {job.status !== "pending" && jobStatusIcon(job.status)}
                  {job.status === "error" && job.error && (
                    <span className="text-[9px] text-red-400 absolute ml-6 whitespace-nowrap">{job.error}</span>
                  )}
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* Progress */}
        {running && (
          <div className="px-6 py-3 border-t border-neutral-800 shrink-0">
            <div className="flex justify-between text-xs text-neutral-400 mb-1">
              <span className="flex items-center gap-1.5">
                <Sparkles className="w-3 h-3 text-amber-400" />
                {jobs.find((j) => j.status === "generating") ? "AI görsel üretiyor…"
                  : jobs.find((j) => j.status === "uploading") ? "Yükleniyor…"
                  : "İşleniyor…"}
              </span>
              <span>{progress.done} / {progress.total}</span>
            </div>
            <div className="h-1 bg-neutral-800 rounded-full overflow-hidden">
              <div className="h-full bg-amber-500 rounded-full transition-all" style={{ width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%` }} />
            </div>
          </div>
        )}

        {/* Footer */}
        <div className="flex gap-3 px-6 py-4 border-t border-neutral-800 shrink-0">
          <button
            onClick={onClose}
            disabled={running}
            className="flex-1 py-2.5 rounded-full border border-neutral-700 text-neutral-300 text-sm hover:border-white disabled:opacity-30 transition-colors"
          >
            Kapat
          </button>
          <button
            onClick={handleGenerate}
            disabled={running || selectedJobs.length === 0}
            className="flex-1 py-2.5 rounded-full text-sm font-semibold disabled:opacity-40 transition-all flex items-center justify-center gap-2"
            style={{ background: "linear-gradient(135deg,#C9A84C1A,#C9A84C0D)", border: "1px solid #C9A84C66", color: "#C9A84C" }}
          >
            {running
              ? <><Loader2 className="w-4 h-4 animate-spin" /> Üretiliyor…</>
              : <><Images className="w-4 h-4" /> {selectedJobs.length} Görsel Üret</>}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ─── BulkPortionModal ───────────────────────────────────────── */
function BulkPortionModal({
  products,
  categories,
  onClose,
  onDone,
}: {
  products: Product[];
  categories: Category[];
  onClose: () => void;
  onDone: () => void;
}) {
  const { toast } = useToast();

  type PortionJob = { productId: number; productName: string; categoryName?: string; portionMin?: number; portionMax?: number; portionUnit?: string; status: "pending" | "running" | "done" | "error"; error?: string };

  const [jobs, setJobs] = useState<PortionJob[]>(() =>
    products.map((p) => ({
      productId:    p.id,
      productName:  p.translations.find((t) => t.languageCode === "tr")?.name ?? p.slug,
      categoryName: categories.find((c) => c.id === p.categoryId)?.translations.find((t) => t.languageCode === "tr")?.name,
      status: "pending" as const,
    }))
  );

  // Pre-select only products missing portionMin
  const [selected, setSelected] = useState<Set<number>>(
    () => new Set(products.filter((p) => !p.portionMin).map((p) => p.id))
  );
  const [running,   setRunning]  = useState(false);
  const [progress,  setProgress] = useState({ done: 0, total: 0 });
  const [filterCat, setFilterCat] = useState<number | null>(null);

  const filteredJobs = filterCat === null
    ? jobs
    : jobs.filter((j) => {
        const p = products.find((p) => p.id === j.productId);
        return p?.categoryId === filterCat;
      });

  function toggle(id: number) {
    setSelected((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }
  function patchJob(id: number, patch: Partial<PortionJob>) {
    setJobs((prev) => prev.map((j) => j.productId === id ? { ...j, ...patch } : j));
  }

  function selectByCategory(catId: number | null) {
    setFilterCat(catId);
    if (catId === null) return;
    const ids = products.filter((p) => p.categoryId === catId).map((p) => p.id);
    setSelected((prev) => { const n = new Set(prev); ids.forEach((id) => n.add(id)); return n; });
  }

  async function handleRun() {
    const toProcess = jobs.filter((j) => selected.has(j.productId));
    if (!toProcess.length) { toast({ title: "En az 1 ürün seçin", variant: "destructive" }); return; }
    setRunning(true);
    setProgress({ done: 0, total: toProcess.length });

    for (let i = 0; i < toProcess.length; i++) {
      const job = toProcess[i];
      patchJob(job.productId, { status: "running" });
      try {
        const result = await apiFetch<{ portionMin?: number; portionMax?: number; portionUnit?: string }>(
          "/ai/generate",
          { method: "POST", body: JSON.stringify({ productName: job.productName, productId: job.productId, category: job.categoryName, languages: ["tr"] }) }
        );
        const min  = (result as any).portionMin  ?? null;
        const max  = (result as any).portionMax  ?? null;
        const unit = (result as any).portionUnit ?? null;
        await apiFetch(`/products/${job.productId}`, {
          method: "PATCH",
          body: JSON.stringify({ portionMin: min, portionMax: max, portionUnit: unit }),
        });
        patchJob(job.productId, { status: "done", portionMin: min, portionMax: max, portionUnit: unit });
      } catch (err) {
        patchJob(job.productId, { status: "error", error: String(err).slice(0, 80) });
      }
      setProgress({ done: i + 1, total: toProcess.length });
    }

    setRunning(false);
    toast({ title: "Gramaj doldurma tamamlandı ✓" });
    onDone();
  }

  return (
    <div className="fixed inset-0 bg-black/80 flex items-end sm:items-center justify-center z-50 p-0 sm:p-4">
      <div className="bg-neutral-900 border border-neutral-800 rounded-t-2xl sm:rounded-2xl w-full max-w-2xl max-h-[94vh] flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b border-neutral-800 shrink-0">
          <div>
            <h2 className="text-white font-semibold flex items-center gap-2">
              <Scale className="w-4 h-4 text-amber-400" /> Toplu Gramaj Doldur
            </h2>
            <p className="text-xs text-neutral-500 mt-0.5">
              Seçili ürünlerin gramajını AI tahmin eder. Yalnızca gramaj güncellenir, diğer veriler korunur.
            </p>
          </div>
          <button onClick={onClose} disabled={running} className="text-neutral-500 hover:text-white text-xl leading-none disabled:opacity-30">✕</button>
        </div>

        {/* Progress */}
        {running && (
          <div className="px-6 py-2 border-b border-neutral-800 shrink-0">
            <div className="flex items-center justify-between text-xs text-neutral-400 mb-1">
              <span>İşleniyor…</span><span>{progress.done} / {progress.total}</span>
            </div>
            <div className="w-full bg-neutral-800 rounded-full h-1"><div className="bg-amber-400 h-1 rounded-full transition-all" style={{ width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%` }} /></div>
          </div>
        )}

        {/* Category filter bar */}
        <div className="px-4 py-2.5 border-b border-neutral-800 shrink-0">
          <div className="flex gap-1.5 overflow-x-auto pb-0.5 scrollbar-none">
            <button
              onClick={() => setFilterCat(null)}
              className={`shrink-0 px-3 py-1 rounded-full text-xs font-medium transition-colors ${filterCat === null ? "bg-white text-black" : "bg-neutral-800 text-neutral-400 hover:text-white"}`}
            >
              Tümü
            </button>
            {categories.map((cat) => {
              const catName = cat.translations.find((t) => t.languageCode === "tr")?.name ?? cat.slug;
              const catProductIds = products.filter((p) => p.categoryId === cat.id).map((p) => p.id);
              const allSelected = catProductIds.length > 0 && catProductIds.every((id) => selected.has(id));
              return (
                <button
                  key={cat.id}
                  onClick={() => selectByCategory(filterCat === cat.id ? null : cat.id)}
                  className={`shrink-0 px-3 py-1 rounded-full text-xs font-medium transition-colors flex items-center gap-1.5 ${
                    filterCat === cat.id ? "bg-amber-500 text-black" : allSelected ? "bg-neutral-700 text-white" : "bg-neutral-800 text-neutral-400 hover:text-white"
                  }`}
                >
                  {catName}
                  <span className={`text-[10px] ${filterCat === cat.id ? "text-black/60" : "text-neutral-500"}`}>
                    {catProductIds.length}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {/* List */}
        <div className="overflow-y-auto flex-1 divide-y divide-neutral-800">
          <div className="flex items-center gap-3 px-6 py-2 text-xs text-neutral-500">
            <span>{selected.size} seçili</span>
            <button onClick={() => setSelected(new Set(products.map((p) => p.id)))} className="underline hover:text-white">Tümünü seç</button>
            <button onClick={() => setSelected(new Set(products.filter((p) => !p.portionMin).map((p) => p.id)))} className="underline hover:text-white">Eksikleri seç</button>
            <button onClick={() => setSelected(new Set())} className="underline hover:text-white">Seçimi kaldır</button>
          </div>
          {filteredJobs.map((job) => {
            const isSel = selected.has(job.productId);
            return (
              <div key={job.productId} className="flex items-center gap-3 px-6 py-3">
                <button onClick={() => !running && toggle(job.productId)} className="flex-shrink-0">
                  {isSel ? <CheckSquare2 className="w-4 h-4 text-white" /> : <Square className="w-4 h-4 text-neutral-600" />}
                </button>
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-white truncate">{job.productName}</p>
                  <p className="text-[10px] text-neutral-600">{job.categoryName ?? "—"}</p>
                  {job.status === "done" && job.portionMin && (
                    <p className="text-xs text-emerald-400">
                      {job.portionMin === job.portionMax ? `~${job.portionMin}` : `${job.portionMin}–${job.portionMax}`} {job.portionUnit}
                    </p>
                  )}
                  {job.status === "error" && <p className="text-xs text-red-400 truncate">{job.error}</p>}
                </div>
                <div className="flex-shrink-0 text-xs text-neutral-600">
                  {job.status === "running" && <Loader2 className="w-3.5 h-3.5 animate-spin text-amber-400" />}
                  {job.status === "done"    && <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />}
                  {job.status === "error"   && <XCircle className="w-3.5 h-3.5 text-red-400" />}
                  {job.status === "pending" && (products.find((p) => p.id === job.productId)?.portionMin
                    ? <span className="text-neutral-600 text-[10px]">mevcut</span>
                    : <span className="text-amber-600 text-[10px]">eksik</span>)}
                </div>
              </div>
            );
          })}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-neutral-800 flex items-center justify-between shrink-0">
          <span className="text-xs text-neutral-500">{selected.size} ürün seçili</span>
          <div className="flex gap-2">
            <button onClick={onClose} disabled={running} className="px-4 py-2 text-sm text-neutral-400 hover:text-white disabled:opacity-30 transition-colors">İptal</button>
            <button
              onClick={handleRun} disabled={running || !selected.size}
              className="flex items-center gap-2 px-4 py-2 bg-amber-500 text-black text-sm font-semibold rounded-full hover:bg-amber-400 disabled:opacity-40 transition-colors"
            >
              {running ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Dolduruluyor…</> : <><Scale className="w-3.5 h-3.5" /> {selected.size} Ürünü Doldur</>}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ─── BulkContentModal ────────────────────────────────────────── */
type ContentJobStatus = "pending" | "running" | "done" | "error";

interface ContentJob {
  productId: number;
  productName: string;
  categoryName?: string;
  status: ContentJobStatus;
  error?: string;
}

function BulkContentModal({
  products,
  categories,
  languages,
  onClose,
  onDone,
}: {
  products: Product[];
  categories: Category[];
  languages: Language[];
  onClose: () => void;
  onDone: () => void;
}) {
  const { toast } = useToast();

  const [jobs, setJobs] = useState<ContentJob[]>(() =>
    products.map((p) => ({
      productId:   p.id,
      productName: p.translations.find((t) => t.languageCode === "tr")?.name ?? p.slug,
      categoryName: categories.find((c) => c.id === p.categoryId)
        ?.translations.find((t) => t.languageCode === "tr")?.name,
      status: "pending" as ContentJobStatus,
    }))
  );
  const [selected, setSelected] = useState<Set<number>>(
    () => new Set(products.map((p) => p.id))
  );
  const [running,  setRunning]  = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });

  function toggle(id: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }
  function selectAll()  { setSelected(new Set(products.map((p) => p.id))); }
  function selectNone() { setSelected(new Set()); }

  function patchJob(id: number, patch: Partial<ContentJob>) {
    setJobs((prev) => prev.map((j) => j.productId === id ? { ...j, ...patch } : j));
  }

  async function handleRun() {
    const toProcess = jobs.filter((j) => selected.has(j.productId));
    if (!toProcess.length) {
      toast({ title: "En az 1 ürün seçin", variant: "destructive" });
      return;
    }
    if (!confirm(`${toProcess.length} ürünün alerjen, içindekiler ve besin değerleri silinip AI ile yeniden yazılacak. Devam edilsin mi?`)) return;

    setRunning(true);
    setProgress({ done: 0, total: toProcess.length });

    const activeLangCodes = languages.filter((l) => l.isActive).map((l) => l.code);

    for (let i = 0; i < toProcess.length; i++) {
      const job = toProcess[i];
      patchJob(job.productId, { status: "running" });

      try {
        const product = products.find((p) => p.id === job.productId)!;

        /* ── Mevcut çevirileri al, isimleri koru ── */
        const existingTranslations = product.translations;

        /* ── AI'ya gönder ── */
        const result = await apiFetch<{
          allergens: string[];
          nutritionFacts: { energy: number; protein: number; carbs: number; fat: number };
          calories: number;
          translations: Record<string, {
            name: string;
            description: string;
            ingredients: string;
            allergenNote: string;
          }>;
        }>("/ai/generate", {
          method: "POST",
          body: JSON.stringify({
            productName: job.productName,
            productId:   job.productId,
            category:    job.categoryName,
            languages:   activeLangCodes,
          }),
        });

        /* ── Mevcut çevirileri AI sonucuyla birleştir (isim & specialNote korunur) ── */
        const mergedTranslations = activeLangCodes.map((code) => {
          const existing = existingTranslations.find((t) => t.languageCode === code);
          const aiTr     = result.translations?.[code];
          return {
            languageCode: code,
            name:         existing?.name || aiTr?.name || job.productName,
            description:  aiTr?.description  ?? existing?.description  ?? "",
            ingredients:  aiTr?.ingredients  ?? existing?.ingredients  ?? "",
            allergenNote: aiTr?.allergenNote  ?? "",
            specialNote:  existing?.specialNote ?? "",
          };
        });

        /* ── Kaydet ── */
        await apiFetch(`/products/${job.productId}`, {
          method: "PATCH",
          body: JSON.stringify({
            allergens:      result.allergens      ?? [],
            calories:       result.calories       ?? null,
            nutritionFacts: result.nutritionFacts ?? {},
            portionMin:     (result as any).portionMin  ?? null,
            portionMax:     (result as any).portionMax  ?? null,
            portionUnit:    (result as any).portionUnit ?? null,
            translations:   mergedTranslations,
          }),
        });

        patchJob(job.productId, { status: "done" });
      } catch (err) {
        patchJob(job.productId, { status: "error", error: String(err).slice(0, 100) });
      }

      setProgress({ done: i + 1, total: toProcess.length });
    }

    setRunning(false);
    toast({ title: "İçerik yenileme tamamlandı ✓" });
    onDone();
  }

  const selectedJobs = jobs.filter((j) => selected.has(j.productId));

  const statusIcon = (s: ContentJobStatus) => {
    if (s === "running") return <Loader2 className="w-3.5 h-3.5 animate-spin text-amber-400" />;
    if (s === "done")    return <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />;
    if (s === "error")   return <XCircle className="w-3.5 h-3.5 text-red-400" />;
    return null;
  };

  return (
    <div className="fixed inset-0 bg-black/80 flex items-end sm:items-center justify-center z-50 p-0 sm:p-4">
      <div className="bg-neutral-900 border border-neutral-800 rounded-t-2xl sm:rounded-2xl w-full max-w-2xl max-h-[94vh] flex flex-col">

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-neutral-800 shrink-0">
          <div>
            <h2 className="text-white font-semibold flex items-center gap-2">
              <RefreshCw className="w-4 h-4 text-amber-400" /> İçerik Yenile
            </h2>
            <p className="text-xs text-neutral-500 mt-0.5">
              Alerjenler, içindekiler ve besin değerleri AI ile yeniden yazılır. Ürün adı, fotoğraf ve fiyat korunur.
            </p>
          </div>
          <button onClick={onClose} disabled={running} className="text-neutral-400 hover:text-white disabled:opacity-30 transition-colors p-1">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Seçim kontrolü */}
        <div className="px-6 pt-3 pb-2 flex items-center gap-3 shrink-0 border-b border-neutral-800/60">
          <span className="text-xs text-neutral-500">Seç:</span>
          <button onClick={selectAll}  disabled={running} className="text-xs text-neutral-400 hover:text-white disabled:opacity-30 transition-colors">Tümü</button>
          <button onClick={selectNone} disabled={running} className="text-xs text-neutral-400 hover:text-white disabled:opacity-30 transition-colors">Hiçbiri</button>
          <span className="ml-auto text-xs text-neutral-500">{selectedJobs.length} / {jobs.length} seçili</span>
        </div>

        {/* Ürün listesi */}
        <div className="overflow-y-auto flex-1 px-6 py-3 space-y-1">
          {jobs.map((job) => (
            <button
              key={job.productId}
              onClick={() => !running && toggle(job.productId)}
              disabled={running}
              className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg border text-left transition-all disabled:cursor-default ${
                selected.has(job.productId)
                  ? "border-amber-800/50 bg-amber-950/20"
                  : "border-neutral-800 bg-neutral-800/30 hover:border-neutral-700"
              }`}
            >
              <div className="shrink-0 text-neutral-500">
                {selected.has(job.productId)
                  ? <CheckSquare2 className="w-4 h-4 text-amber-400" />
                  : <Square className="w-4 h-4" />}
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm text-white truncate">{job.productName}</div>
                <div className="text-[10px] text-neutral-500">{job.categoryName ?? "—"}</div>
              </div>
              <div className="shrink-0 w-5 flex items-center justify-center">
                {statusIcon(job.status)}
              </div>
              {job.status === "error" && job.error && (
                <span className="absolute right-12 text-[9px] text-red-400 max-w-[160px] truncate">{job.error}</span>
              )}
            </button>
          ))}
        </div>

        {/* Progress bar */}
        {running && (
          <div className="px-6 py-3 border-t border-neutral-800 shrink-0">
            <div className="flex justify-between text-xs text-neutral-400 mb-1.5">
              <span className="flex items-center gap-1.5">
                <Sparkles className="w-3 h-3 text-amber-400" /> AI içerik yazıyor…
              </span>
              <span>{progress.done} / {progress.total}</span>
            </div>
            <div className="h-1 bg-neutral-800 rounded-full overflow-hidden">
              <div
                className="h-full bg-amber-500 rounded-full transition-all duration-300"
                style={{ width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%` }}
              />
            </div>
          </div>
        )}

        {/* Footer */}
        <div className="flex gap-3 px-6 py-4 border-t border-neutral-800 shrink-0">
          <button onClick={onClose} disabled={running} className="flex-1 py-2.5 rounded-full border border-neutral-700 text-neutral-300 text-sm hover:border-white disabled:opacity-30 transition-colors">
            Kapat
          </button>
          <button
            onClick={handleRun}
            disabled={running || selectedJobs.length === 0}
            className="flex-1 py-2.5 rounded-full text-sm font-semibold disabled:opacity-40 transition-all flex items-center justify-center gap-2"
            style={{ background: "linear-gradient(135deg,#C9A84C1A,#C9A84C0D)", border: "1px solid #C9A84C66", color: "#C9A84C" }}
          >
            {running
              ? <><Loader2 className="w-4 h-4 animate-spin" /> Yazılıyor…</>
              : <><RefreshCw className="w-4 h-4" /> {selectedJobs.length} Ürünü Yenile</>}
          </button>
        </div>
      </div>
    </div>
  );
}

function formatViewCount(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}

/* ─── ImageUploader ─────────────────────────────────────────────── */
function ImageUploader({ value, onChange }: { value: string; onChange: (url: string) => void }) {
  const { toast } = useToast();
  const fileRef   = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [compInfo, setCompInfo]   = useState<string | null>(null);

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      toast({ title: "Sadece görsel dosyaları desteklenir", variant: "destructive" });
      return;
    }
    setUploading(true);
    setCompInfo(null);
    try {
      const originalSize = file.size;
      const compressed   = await compressImage(file);
      const ratio = originalSize > 0 ? Math.round((1 - compressed.size / originalSize) * 100) : 0;
      setCompInfo(`${formatBytes(originalSize)} → ${formatBytes(compressed.size)}${ratio > 0 ? ` (-%${ratio})` : ""}`);
      const url = await uploadBlob(compressed, file.name.replace(/\.[^.]+$/, ".jpg"));
      onChange(url);
      toast({ title: "Görsel yüklendi ✓" });
    } catch (err) {
      toast({ title: "Görsel yükleme hatası", description: String(err), variant: "destructive" });
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  const inputCls = "w-full bg-neutral-800 border border-neutral-700 text-white rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-white";

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="https://... veya dosya yükleyin"
          className={inputCls}
        />
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={uploading}
          className="flex items-center gap-1.5 px-3 py-2 bg-neutral-800 border border-neutral-700 text-neutral-300 text-sm rounded-lg hover:text-white hover:border-neutral-500 disabled:opacity-50 transition-colors whitespace-nowrap"
        >
          {uploading ? <span className="animate-spin text-xs">⟳</span> : <Upload className="w-4 h-4" />}
          {uploading ? "Yükleniyor..." : "Yükle"}
        </button>
      </div>
      {compInfo && <p className="text-xs text-emerald-500">{compInfo} · optimize edildi</p>}
      <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={handleFile} />
      {value ? (
        <div className="flex items-center gap-3">
          <img
            src={value} alt="Önizleme"
            className="w-16 h-16 rounded-lg object-cover border border-neutral-700 flex-shrink-0"
            onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
          />
          <button type="button" onClick={() => { onChange(""); setCompInfo(null); }} className="text-xs text-neutral-500 hover:text-red-400 transition-colors">
            Görseli kaldır
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-2 p-3 border border-dashed border-neutral-700 rounded-lg text-neutral-600">
          <ImageIcon className="w-4 h-4" />
          <span className="text-xs">Görsel eklenmedi — max 1200px, JPEG ≤200 KB hedef</span>
        </div>
      )}
    </div>
  );
}

/* ─── SortableProductRow ─────────────────────────────────────────── */
function SortableProductRow({
  product, categories, viewCount, onEdit, onDelete,
}: {
  product: Product;
  categories: Category[];
  viewCount?: number;
  onEdit: (p: Product) => void;
  onDelete: (id: number) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id: product.id });
  const style   = { transform: CSS.Transform.toString(transform), transition };
  const trName  = product.translations.find((t) => t.languageCode === "tr")?.name ?? product.slug;
  const catName = categories.find((c) => c.id === product.categoryId)?.translations.find((t) => t.languageCode === "tr")?.name ?? "—";

  return (
    <div ref={setNodeRef} style={style} className="flex items-center gap-3 bg-neutral-900 border border-neutral-800 rounded-lg px-4 py-3">
      <button {...attributes} {...listeners} className="text-neutral-600 hover:text-neutral-400 cursor-grab">
        <GripVertical className="w-4 h-4" />
      </button>
      {product.imageUrl ? (
        <img src={product.imageUrl} alt={trName} className="w-10 h-10 rounded-lg object-cover flex-shrink-0" />
      ) : (
        <div className="w-10 h-10 rounded-lg bg-neutral-800 flex items-center justify-center flex-shrink-0">
          <Image className="w-4 h-4 text-neutral-600" />
        </div>
      )}
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-white truncate">{trName}</div>
        <div className="text-xs text-neutral-500">{catName}</div>
      </div>
      {viewCount != null && viewCount > 0 && (
        <div className="flex items-center gap-1 text-xs text-neutral-500">
          <Eye className="w-3 h-3" /><span>{formatViewCount(viewCount)}</span>
        </div>
      )}
      <div className="text-sm text-neutral-300 font-medium">
        {product.price > 0 ? `${product.price} ${product.currency ?? "TRY"}` : "—"}
      </div>
      <span className={`text-xs px-2 py-0.5 rounded-full ${product.isActive ? "bg-emerald-900/40 text-emerald-400" : "bg-neutral-800 text-neutral-500"}`}>
        {product.isActive ? "Aktif" : "Pasif"}
      </span>
      <button onClick={() => onEdit(product)} className="text-neutral-500 hover:text-white transition-colors p-1"><Pencil className="w-4 h-4" /></button>
      <button onClick={() => onDelete(product.id)} className="text-neutral-500 hover:text-red-400 transition-colors p-1"><Trash2 className="w-4 h-4" /></button>
    </div>
  );
}

/* ─── Helper ─────────────────────────────────────────────────────── */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/ğ/g, "g").replace(/ü/g, "u").replace(/ş/g, "s")
    .replace(/ı/g, "i").replace(/ö/g, "o").replace(/ç/g, "c")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/* ─── ProductModal ───────────────────────────────────────────────── */
function ProductModal({
  product, categories, languages, onClose, onSave,
}: {
  product: Partial<Product> | null;
  categories: Category[];
  languages: Language[];
  onClose: () => void;
  onSave: () => void;
}) {
  const { toast } = useToast();

  /* ── Core state ── */
  const [slug,       setSlug]       = useState(product?.slug ?? "");
  const [categoryId, setCategoryId] = useState(product?.categoryId ?? categories[0]?.id ?? 0);
  const [price,      setPrice]      = useState(String(product?.price ?? ""));
  const [isActive,   setIsActive]   = useState(product?.isActive ?? true);
  const [isPopular,  setIsPopular]  = useState(product?.isPopular ?? false);
  const [portionMin, setPortionMin] = useState(String(product?.portionMin ?? ""));
  const [portionMax, setPortionMax] = useState(String(product?.portionMax ?? ""));
  const [portionUnit, setPortionUnit] = useState(product?.portionUnit ?? "g");
  const [imageUrl,   setImageUrl]   = useState(product?.imageUrl ?? "");
  const [calories,   setCalories]   = useState(String(product?.calories ?? ""));

  /* ── Details section ── */
  const [detailsOpen,  setDetailsOpen]  = useState(!!(product?.id)); // open when editing
  const [allergens,    setAllergens]    = useState<string[]>((product?.allergens ?? []).map(normalizeAllergenKey));
  const [customAllergen, setCustomAllergen] = useState("");
  const [nutrition,    setNutrition]    = useState<NutritionFacts>(product?.nutritionFacts ?? {});
  const [translations, setTranslations] = useState<Translation[]>(
    languages.map((l) => {
      const ex = product?.translations?.find((t) => t.languageCode === l.code);
      return {
        languageCode: l.code,
        name:         ex?.name         ?? "",
        description:  ex?.description  ?? "",
        ingredients:  ex?.ingredients  ?? "",
        allergenNote: ex?.allergenNote ?? "",
        specialNote:  ex?.specialNote  ?? "",
      };
    })
  );
  const [activeLang, setActiveLang] = useState(languages[0]?.code ?? "tr");

  /* ── Loading flags ── */
  const [saving,         setSaving]         = useState(false);
  const [aiLoading,      setAiLoading]      = useState(false);
  const [aiImageLoading, setAiImageLoading] = useState(false);
  const [optimizing,     setOptimizing]     = useState(false);
  const [aiFlash,        setAiFlash]        = useState(false);
  const [imgStyle,       setImgStyle]       = useState<"restaurant"|"professional"|"rustic"|"minimal"|"outdoor">("restaurant");

  /* ── Derived ── */
  const trName   = translations.find((t) => t.languageCode === "tr")?.name ?? "";
  const priceNum = parseFloat(price);
  const aiReady  = !aiLoading && !!trName && !!price && priceNum > 0;

  /* ── Helpers ── */
  function updateTr(code: string, field: keyof Omit<Translation, "languageCode">, value: string) {
    setTranslations((prev) => prev.map((t) => (t.languageCode === code ? { ...t, [field]: value } : t)));
  }

  function handleTrNameChange(value: string) {
    updateTr("tr", "name", value);
    if (!product?.id) setSlug(slugify(value));
  }

  function toggleAllergen(key: string) {
    const norm = normalizeAllergenKey(key);
    setAllergens((prev) => prev.includes(norm) ? prev.filter((a) => a !== norm) : [...prev, norm]);
  }

  function addCustomAllergen() {
    const val = customAllergen.trim().toLowerCase();
    if (val && !allergens.includes(val)) setAllergens((prev) => [...prev, val]);
    setCustomAllergen("");
  }

  function setNutrField(field: keyof NutritionFacts, value: string) {
    const num = parseFloat(value);
    setNutrition((prev) => ({ ...prev, [field]: isNaN(num) ? undefined : num }));
  }

  /* ── AI content generation ── */
  async function handleAiGenerate() {
    if (!aiReady) {
      toast({ title: "Türkçe ad ve fiyat girilmeli", variant: "destructive" });
      return;
    }
    setAiLoading(true);
    try {
      const cat     = categories.find((c) => c.id === categoryId);
      const catName = cat?.translations.find((t) => t.languageCode === "tr")?.name;
      const result  = await apiFetch<{
        allergens?: string[];
        calories?: number;
        nutritionFacts?: NutritionFacts;
        translations: Record<string, { name: string; description: string; ingredients: string; allergenNote: string }>;
      }>("/ai/generate", {
        method: "POST",
        body: JSON.stringify({ productName: trName, productId: product?.id, category: catName, languages: languages.map((l) => l.code) }),
      });

      if (result.allergens?.length) setAllergens(result.allergens.map(normalizeAllergenKey));
      if (result.calories)       setCalories(String(result.calories));
      if (result.nutritionFacts) setNutrition(result.nutritionFacts);
      if ((result as any).portionMin) setPortionMin(String((result as any).portionMin));
      if ((result as any).portionMax) setPortionMax(String((result as any).portionMax));
      if ((result as any).portionUnit) setPortionUnit((result as any).portionUnit);

      setTranslations((prev) =>
        prev.map((t) => {
          const gen = result.translations?.[t.languageCode];
          if (!gen) return t;
          return { ...t, name: gen.name || t.name, description: gen.description || t.description, ingredients: gen.ingredients || t.ingredients, allergenNote: gen.allergenNote || t.allergenNote };
        })
      );

      setDetailsOpen(true);          // auto-expand Ayrıntılar
      setAiFlash(true);
      setTimeout(() => setAiFlash(false), 2500);
      toast({ title: "✦ AI içerik üretildi", description: "Tüm diller ve besin değerleri dolduruldu." });
    } catch (err) {
      toast({ title: "AI hatası", description: String(err), variant: "destructive" });
    } finally {
      setAiLoading(false);
    }
  }

  /* ── AI image generation — returned as b64, compressed client-side ── */
  async function handleAiImageGenerate() {
    if (!trName) { toast({ title: "Önce Türkçe ürün adını girin", variant: "destructive" }); return; }
    setAiImageLoading(true);
    try {
      const cat    = categories.find((c) => c.id === categoryId);
      const trDesc = translations.find((t) => t.languageCode === "tr")?.description;
      const result = await apiFetch<{ b64: string }>("/ai/generate-image", {
        method: "POST",
        body: JSON.stringify({ productName: trName, productId: product?.id, category: cat?.translations.find((t) => t.languageCode === "tr")?.name, notes: trDesc, style: imgStyle }),
      });

      /* Same compression pipeline as manual file uploads */
      const blob = await compressDataUrl(`data:image/jpeg;base64,${result.b64}`);
      const url  = await uploadBlob(blob, "ai-image.jpg");
      setImageUrl(url);
      toast({ title: "AI görseli yüklendi ✓", description: `${formatBytes(blob.size)} · optimize edildi` });
    } catch (err) {
      toast({ title: "Görsel üretme hatası", description: String(err), variant: "destructive" });
    } finally {
      setAiImageLoading(false);
    }
  }

  /* ── Optimize existing image (server-side, CORS-free) ── */
  async function handleOptimize() {
    if (!imageUrl) return;
    setOptimizing(true);
    try {
      const { servingUrl, size } = await optimizeImageUrl(imageUrl);
      setImageUrl(servingUrl);
      toast({ title: "Görsel optimize edildi ✓", description: formatBytes(size) });
    } catch (err) {
      toast({ title: "Optimizasyon hatası", description: String(err), variant: "destructive" });
    } finally {
      setOptimizing(false);
    }
  }

  /* ── Save ── */
  async function handleSave() {
    if (!slug) { toast({ title: "Slug zorunlu", variant: "destructive" }); return; }
    setSaving(true);
    try {
      const nutriFilled = Object.values(nutrition).some((v) => v != null && !isNaN(v as number));
      const payload = {
        slug,
        categoryId:   Number(categoryId),
        price:        parseFloat(price) || 0,
        isActive,
        isPopular,
        portionMin:   portionMin ? parseInt(portionMin) : null,
        portionMax:   portionMax ? parseInt(portionMax) : null,
        portionUnit:  portionMin || portionMax ? portionUnit : null,
        imageUrl:     imageUrl || undefined,
        calories:     calories ? parseInt(calories) : undefined,
        allergens,
        nutritionFacts: nutriFilled ? nutrition : {},
        translations:   translations.filter((t) => t.name),
      };
      if (product?.id) {
        await apiFetch(`/products/${product.id}`, { method: "PATCH", body: JSON.stringify(payload) });
      } else {
        await apiFetch("/products", { method: "POST", body: JSON.stringify(payload) });
      }
      onSave();
      onClose();
    } catch (err) {
      toast({ title: "Hata", description: String(err), variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  /* ── Styles ── */
  const inputCls    = "w-full bg-neutral-800 border border-neutral-700 text-white rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-white";
  const numInputCls = `${inputCls} [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none`;
  const flashRing   = aiFlash ? "ring-1 ring-amber-500/60" : "";

  const activeTr      = translations.find((t) => t.languageCode === activeLang)!;
  const customAllergens = allergens.filter((a) => !ALLERGEN_CHIPS.find((c) => c.key === a));

  return (
    <div className="fixed inset-0 bg-black/80 flex items-end sm:items-center justify-center z-50 p-0 sm:p-4">
      <div className="bg-neutral-900 border border-neutral-800 rounded-t-2xl sm:rounded-2xl w-full max-w-2xl max-h-[94vh] flex flex-col">

        {/* ── Header ── */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-neutral-800 shrink-0">
          <div>
            <h2 className="text-white font-semibold">{product?.id ? "Ürün Düzenle" : "Yeni Ürün"}</h2>
            {slug && <p className="text-xs text-neutral-500 mt-0.5 font-mono">/{slug}</p>}
          </div>
          <button onClick={onClose} className="text-neutral-400 hover:text-white transition-colors p-1"><X className="w-5 h-5" /></button>
        </div>

        {/* ── Scrollable body ── */}
        <div className="overflow-y-auto flex-1 px-6 py-5 space-y-5">

          {/* ────── AI BUTTON ────── */}
          <button
            type="button"
            onClick={handleAiGenerate}
            disabled={!aiReady}
            title={!trName ? "Türkçe ad girin" : !price || priceNum <= 0 ? "Geçerli fiyat girin" : undefined}
            className="w-full py-3.5 rounded-xl font-semibold text-sm transition-all flex items-center justify-center gap-2.5 disabled:cursor-not-allowed"
            style={
              aiReady
                ? { background: "linear-gradient(135deg, #C9A84C1A 0%, #C9A84C0D 100%)", border: "1px solid #C9A84C66", color: "#C9A84C" }
                : { background: "#111", border: "1px solid #2a2a2a", color: "#444" }
            }
          >
            {aiLoading ? (
              <><span className="animate-spin text-base">✦</span> AI üretiyor…</>
            ) : (
              <>
                <Sparkles className="w-4 h-4" />
                ✦ AI ile Tümünü Doldur
                <span className="text-xs opacity-50 font-normal">ad + fiyat gerekli</span>
              </>
            )}
          </button>

          {/* ────── TEMEL BİLGİLER ────── */}
          <div className="space-y-3">
            <p className="text-[10px] text-neutral-500 uppercase tracking-widest">Temel Bilgiler</p>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-neutral-400 mb-1.5">Türkçe Ad *</label>
                <input
                  value={trName}
                  onChange={(e) => handleTrNameChange(e.target.value)}
                  placeholder="Örn: Izgara Levrek"
                  className={`${inputCls} ${aiFlash && trName ? "ring-1 ring-amber-500/50" : ""}`}
                />
              </div>
              <div>
                <label className="block text-xs text-neutral-400 mb-1.5">Fiyat (TRY) *</label>
                <input
                  type="number" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="0"
                  className={numInputCls}
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-neutral-400 mb-1.5">Kategori</label>
                <select value={categoryId} onChange={(e) => setCategoryId(Number(e.target.value))} className={inputCls}>
                  {categories.map((c) => (
                    <option key={c.id} value={c.id}>{c.translations.find((t) => t.languageCode === "tr")?.name ?? c.slug}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs text-neutral-400 mb-1.5">Kalori (kcal)</label>
                <input
                  type="number" value={calories} onChange={(e) => setCalories(e.target.value)} placeholder="—"
                  className={`${numInputCls} ${aiFlash && calories ? "ring-1 ring-amber-500/50" : ""}`}
                />
              </div>
            </div>

            {/* Gramaj */}
            <div>
              <label className="block text-xs text-neutral-400 mb-1.5">Gramaj / Hacim (porsiyon aralığı)</label>
              <div className="flex gap-2 items-center">
                <input
                  type="number" value={portionMin} onChange={(e) => setPortionMin(e.target.value)} placeholder="min"
                  className={`${numInputCls} flex-1 ${aiFlash && portionMin ? "ring-1 ring-amber-500/50" : ""}`}
                />
                <span className="text-neutral-500 text-sm flex-shrink-0">–</span>
                <input
                  type="number" value={portionMax} onChange={(e) => setPortionMax(e.target.value)} placeholder="max"
                  className={`${numInputCls} flex-1 ${aiFlash && portionMax ? "ring-1 ring-amber-500/50" : ""}`}
                />
                <select value={portionUnit} onChange={(e) => setPortionUnit(e.target.value)} className={`${inputCls} w-20 flex-shrink-0`}>
                  <option value="g">g</option>
                  <option value="ml">ml</option>
                  <option value="cl">cl</option>
                  <option value="adet">adet</option>
                </select>
              </div>
              <p className="mt-1 text-xs text-neutral-600">AI otomatik doldurur. Yemek → g, içecek → ml. Örn: 200 – 250 g</p>
            </div>

            <div className="flex items-center gap-3">
              <span className="text-sm text-neutral-300">Aktif</span>
              <button
                type="button" onClick={() => setIsActive(!isActive)}
                className={`w-10 h-5 rounded-full transition-colors relative ${isActive ? "bg-white" : "bg-neutral-700"}`}
              >
                <span className={`absolute top-0.5 w-4 h-4 bg-neutral-900 rounded-full transition-transform ${isActive ? "translate-x-5" : "translate-x-0.5"}`} />
              </button>
              <span className="text-xs text-neutral-500">{isActive ? "Menüde görünür" : "Gizli"}</span>
            </div>

            <div className="flex items-center gap-3">
              <span className="text-sm text-neutral-300">Popüler Ürün</span>
              <button
                type="button" onClick={() => setIsPopular(!isPopular)}
                className={`w-10 h-5 rounded-full transition-colors relative ${isPopular ? "" : "bg-neutral-700"}`}
                style={isPopular ? { background: "#C9A84C" } : {}}
              >
                <span className={`absolute top-0.5 w-4 h-4 bg-neutral-900 rounded-full transition-transform ${isPopular ? "translate-x-5" : "translate-x-0.5"}`} />
              </button>
              <span className="text-xs text-neutral-500">{isPopular ? "Ana sayfada gösterilir" : "Normal ürün"}</span>
            </div>
          </div>

          {/* ────── GÖRSEL ────── */}
          <div className="space-y-2">
            <p className="text-[10px] text-neutral-500 uppercase tracking-widest">Görsel</p>
            <ImageUploader value={imageUrl} onChange={setImageUrl} />

            {/* Style selector */}
            <div className="space-y-1.5">
              <p className="text-[10px] text-neutral-600 uppercase tracking-widest">AI görsel stili</p>
              <div className="grid grid-cols-2 gap-1.5">
                {([
                  { key: "restaurant",   label: "🍽️ Restoran",    desc: "Sıcak, doğal ortam" },
                  { key: "professional", label: "📸 Profesyonel", desc: "Koyu fon, dramatik ışık" },
                  { key: "rustic",       label: "🌿 Rustik",      desc: "Ahşap, güneş ışığı" },
                  { key: "minimal",      label: "◾ Minimalist",   desc: "Sade, temiz kompozisyon" },
                  { key: "outdoor",      label: "🌳 Doğa",        desc: "Bahçe, teras, açık hava" },
                ] as const).map(({ key, label, desc }) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setImgStyle(key)}
                    className={`flex flex-col items-start px-2.5 py-2 rounded-lg border text-left text-xs transition-colors ${
                      imgStyle === key
                        ? "border-amber-500/70 bg-amber-500/10 text-amber-300"
                        : "border-neutral-700 bg-neutral-800/50 text-neutral-400 hover:border-neutral-500 hover:text-neutral-300"
                    }`}
                  >
                    <span className="font-medium leading-tight">{label}</span>
                    <span className="text-[10px] opacity-70 leading-tight mt-0.5">{desc}</span>
                  </button>
                ))}
              </div>
            </div>

            <button
              type="button" onClick={handleAiImageGenerate}
              disabled={aiImageLoading || !trName}
              className="flex items-center gap-2 w-full justify-center px-3 py-2.5 bg-neutral-800 border border-neutral-700 text-neutral-300 text-sm rounded-lg hover:text-white hover:border-neutral-500 disabled:opacity-40 transition-colors"
            >
              {aiImageLoading
                ? <><span className="animate-spin text-xs">⟳</span> Görsel üretiliyor… (~20-30 sn)</>
                : <><Sparkles className="w-4 h-4 text-amber-500" /> AI ile Görsel Üret</>}
            </button>

            {imageUrl && (
              <button
                type="button" onClick={handleOptimize}
                disabled={optimizing}
                className="flex items-center gap-2 w-full justify-center px-3 py-2 bg-neutral-800 border border-neutral-700 text-neutral-500 text-sm rounded-lg hover:text-neutral-300 hover:border-neutral-500 disabled:opacity-40 transition-colors"
              >
                {optimizing
                  ? <><span className="animate-spin text-xs">⟳</span> Optimize ediliyor…</>
                  : <><Image className="w-4 h-4" /> Görseli Optimize Et</>}
              </button>
            )}
          </div>

          {/* ────── AYRINTI BÖLÜMÜ (collapsible) ────── */}
          <div className={`border rounded-xl overflow-hidden transition-colors ${flashRing || "border-neutral-800"}`}>
            <button
              type="button"
              onClick={() => setDetailsOpen((v) => !v)}
              className="w-full flex items-center justify-between px-4 py-3.5 text-sm text-neutral-300 hover:text-white transition-colors"
            >
              <span className="font-medium">
                Ayrıntılar
                <span className="text-xs text-neutral-500 font-normal ml-2">çeviri · alerjen · besin</span>
              </span>
              {detailsOpen ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
            </button>

            {detailsOpen && (
              <div className="px-4 pb-5 space-y-5 border-t border-neutral-800 pt-4">

                {/* Dil sekmeleri */}
                <div>
                  <div className="flex gap-0.5 mb-3 bg-neutral-800 rounded-lg p-1">
                    {languages.map((l) => {
                      const tr     = translations.find((t) => t.languageCode === l.code);
                      const filled = !!(tr?.name || tr?.description);
                      return (
                        <button
                          key={l.code} type="button" onClick={() => setActiveLang(l.code)}
                          className={`flex items-center gap-1.5 flex-1 justify-center py-1.5 text-xs font-medium rounded-md transition-colors relative ${
                            activeLang === l.code ? "bg-neutral-700 text-white" : "text-neutral-500 hover:text-neutral-300"
                          }`}
                        >
                          <span>{LANG_FLAGS[l.code] ?? "🌐"}</span>
                          <span>{l.code.toUpperCase()}</span>
                          {filled && <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 absolute top-1 right-1" />}
                        </button>
                      );
                    })}
                  </div>

                  <div className="space-y-2.5">
                    <div>
                      <label className="block text-xs text-neutral-500 mb-1">Ad</label>
                      <input
                        value={activeTr?.name ?? ""}
                        onChange={(e) => { if (activeLang === "tr") handleTrNameChange(e.target.value); else updateTr(activeLang, "name", e.target.value); }}
                        placeholder="Ürün adı"
                        className={inputCls}
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-neutral-500 mb-1">Açıklama</label>
                      <textarea
                        value={activeTr?.description ?? ""} onChange={(e) => updateTr(activeLang, "description", e.target.value)}
                        placeholder="Lezzetli bir açıklama…" rows={3} className={`${inputCls} resize-none`}
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-neutral-500 mb-1">İçindekiler</label>
                      <input
                        value={activeTr?.ingredients ?? ""} onChange={(e) => updateTr(activeLang, "ingredients", e.target.value)}
                        placeholder="Malzemeler virgülle ayrılmış" className={inputCls}
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-neutral-500 mb-1">Alerjen Notu</label>
                      <input
                        value={activeTr?.allergenNote ?? ""} onChange={(e) => updateTr(activeLang, "allergenNote", e.target.value)}
                        placeholder="Örn: Gluten ve süt ürünleri içerir." className={inputCls}
                      />
                    </div>
                  </div>
                </div>

                {/* Alerjen chips */}
                <div className="space-y-2.5">
                  <p className="text-xs text-neutral-500 uppercase tracking-widest">Alerjenler</p>
                  <div className="flex flex-wrap gap-2">
                    {ALLERGEN_CHIPS.map((chip) => {
                      const active = allergens.includes(chip.key);
                      return (
                        <button
                          key={chip.key} type="button" onClick={() => toggleAllergen(chip.key)}
                          className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium border transition-all"
                          style={active
                            ? { background: "#C9A84C22", borderColor: "#C9A84C88", color: "#C9A84C" }
                            : { background: "transparent", borderColor: "#333", color: "#666" }}
                        >
                          <span>{chip.icon}</span><span>{chip.label}</span>
                        </button>
                      );
                    })}
                  </div>
                  {customAllergens.length > 0 && (
                    <div className="flex flex-wrap gap-2">
                      {customAllergens.map((a) => (
                        <span key={a} className="flex items-center gap-1 px-2.5 py-1 rounded-full text-xs border border-neutral-700 text-neutral-400">
                          {a}
                          <button type="button" onClick={() => setAllergens((prev) => prev.filter((x) => x !== a))} className="text-neutral-600 hover:text-red-400 ml-0.5">×</button>
                        </span>
                      ))}
                    </div>
                  )}
                  <div className="flex gap-2">
                    <input
                      value={customAllergen} onChange={(e) => setCustomAllergen(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addCustomAllergen(); } }}
                      placeholder="Özel alerjen ekle…"
                      className="flex-1 bg-neutral-800 border border-neutral-700 text-white rounded-lg px-3 py-1.5 text-xs focus:outline-none focus:border-white"
                    />
                    <button type="button" onClick={addCustomAllergen} className="px-3 py-1.5 text-xs bg-neutral-800 border border-neutral-700 text-neutral-400 rounded-lg hover:text-white transition-colors">
                      Ekle
                    </button>
                  </div>
                </div>

                {/* Besin değerleri */}
                <div className="space-y-2.5">
                  <p className="text-xs text-neutral-500 uppercase tracking-widest">Besin Değerleri (porsiyon)</p>
                  <div className="grid grid-cols-2 gap-3">
                    {([
                      { field: "energy"  as const, label: "Enerji (kcal)" },
                      { field: "protein" as const, label: "Protein (g)"   },
                      { field: "carbs"   as const, label: "Karbonhidrat (g)" },
                      { field: "fat"     as const, label: "Yağ (g)"       },
                    ] as const).map(({ field, label }) => (
                      <div key={field}>
                        <label className="block text-xs text-neutral-500 mb-1">{label}</label>
                        <input
                          type="number" value={nutrition[field] ?? ""} onChange={(e) => setNutrField(field, e.target.value)} placeholder="—"
                          className={`${numInputCls} ${aiFlash && nutrition[field] ? "ring-1 ring-amber-500/50" : ""}`}
                        />
                      </div>
                    ))}
                  </div>
                </div>

              </div>
            )}
          </div>

          {/* Slug */}
          <div>
            <label className="block text-xs text-neutral-500 mb-1 uppercase tracking-widest">URL Slug</label>
            <input value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="ornek-urun-adi" className={inputCls} />
          </div>

          <div className="flex items-start gap-2 px-3 py-2 bg-amber-950/30 border border-amber-800/40 rounded-lg">
            <Sparkles className="w-3 h-3 text-amber-700 mt-0.5 shrink-0" />
            <p className="text-xs text-amber-700/90 leading-relaxed">
              AI içerikleri hatalı olabilir — yayınlamadan önce tüm dil sekmelerini kontrol edin.
            </p>
          </div>
        </div>

        {/* ── Footer ── */}
        <div className="flex gap-3 px-6 py-4 border-t border-neutral-800 shrink-0">
          <button type="button" onClick={onClose} className="flex-1 py-2.5 rounded-full border border-neutral-700 text-neutral-300 text-sm hover:border-white transition-colors">
            İptal
          </button>
          <button type="button" onClick={handleSave} disabled={saving} className="flex-1 py-2.5 rounded-full bg-white text-black text-sm font-semibold hover:bg-neutral-100 disabled:opacity-50 transition-colors">
            {saving ? "Kaydediliyor…" : product?.id ? "Güncelle" : "Ürün Ekle"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ─── AdminProducts ───────────────────────────────────────────────── */
export default function AdminProducts() {
  const { toast } = useToast();
  const [products,   setProducts]   = useState<Product[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [languages,  setLanguages]  = useState<Language[]>([]);
  const [viewCounts, setViewCounts] = useState<Record<number, number>>({});
  const [editing,    setEditing]    = useState<Partial<Product> | null | false>(false);
  const [filterCat,  setFilterCat]  = useState<number | "all">("all");
  const [search,     setSearch]     = useState("");

  const sensors = useSensors(useSensor(PointerSensor));
  const [bulkOptimizing, setBulkOptimizing] = useState(false);
  const [bulkProgress,   setBulkProgress]   = useState<{ done: number; total: number } | null>(null);
  const [showBulkAdd,     setShowBulkAdd]     = useState(false);
  const [showBulkImage,   setShowBulkImage]   = useState(false);
  const [showBulkContent, setShowBulkContent] = useState(false);
  const [showBulkPortion, setShowBulkPortion] = useState(false);

  async function handleBulkOptimize() {
    const withImages = products.filter((p) => p.imageUrl);
    if (!withImages.length) { toast({ title: "Optimize edilecek görsel yok" }); return; }
    if (!confirm(`${withImages.length} ürünün görseli yeniden optimize edilecek. Devam edilsin mi?`)) return;
    setBulkOptimizing(true);
    setBulkProgress({ done: 0, total: withImages.length });
    let done = 0;
    let failed = 0;
    for (const p of withImages) {
      try {
        const { servingUrl } = await optimizeImageUrl(p.imageUrl!);
        await apiFetch(`/products/${p.id}`, { method: "PATCH", body: JSON.stringify({ imageUrl: servingUrl }) });
      } catch { failed++; }
      done++;
      setBulkProgress({ done, total: withImages.length });
    }
    const ok = withImages.length - failed;
    toast({
      title: "Toplu optimizasyon tamamlandı",
      description: failed > 0 ? `${ok} başarılı, ${failed} başarısız` : `${ok} görsel optimize edildi`,
    });
    setBulkOptimizing(false);
    setBulkProgress(null);
    load();
  }

  async function load() {
    const [prods, cats, langs] = await Promise.all([
      apiFetch<Product[]>("/products"),
      apiFetch<Category[]>("/categories"),
      apiFetch<Language[]>("/languages"),
    ]);
    setProducts(prods.sort((a, b) => a.sortOrder - b.sortOrder));
    setCategories(cats);
    setLanguages(langs);
    apiFetch<Record<number, number>>("/analytics/product-views").then(setViewCounts).catch(() => {});
  }

  useEffect(() => { load(); }, []);

  async function handleDelete(id: number) {
    if (!confirm("Bu ürünü silmek istediğinizden emin misiniz?")) return;
    await apiFetch(`/products/${id}`, { method: "DELETE" });
    toast({ title: "Ürün silindi" });
    load();
  }

  async function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const filtered = filteredProducts;
    const oldIndex = filtered.findIndex((p) => p.id === active.id);
    const newIndex = filtered.findIndex((p) => p.id === over.id);
    const reordered = arrayMove(filtered, oldIndex, newIndex);
    setProducts((prev) => {
      const others = prev.filter((p) => !reordered.find((r) => r.id === p.id));
      return [...others, ...reordered].sort((a, b) => {
        const ai = reordered.findIndex((r) => r.id === a.id);
        const bi = reordered.findIndex((r) => r.id === b.id);
        return ai !== -1 && bi !== -1 ? ai - bi : 0;
      });
    });
    await apiFetch("/products/reorder", { method: "POST", body: JSON.stringify({ ids: reordered.map((p) => p.id) }) });
  }

  const filteredProducts = products
    .filter((p) => filterCat === "all" || p.categoryId === filterCat)
    .filter((p) => {
      if (!search.trim()) return true;
      const q = search.toLowerCase();
      return (
        p.translations.some((t) => t.name.toLowerCase().includes(q)) ||
        p.slug.toLowerCase().includes(q)
      );
    });

  return (
    <div className="space-y-5 max-w-3xl">
      {/* ── Başlık + butonlar ── */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-white">Ürünler</h1>
          <p className="text-neutral-500 text-sm mt-0.5">
            {filteredProducts.length !== products.length
              ? `${filteredProducts.length} / ${products.length} ürün`
              : `${products.length} ürün · sürükleyerek sıralayın`}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap justify-end">
          {bulkProgress && (
            <span className="text-xs text-neutral-400">{bulkProgress.done} / {bulkProgress.total} işlendi</span>
          )}
          <button
            onClick={handleBulkOptimize}
            disabled={bulkOptimizing}
            className="flex items-center gap-2 px-3 py-2 bg-neutral-800 border border-neutral-700 text-neutral-400 text-sm rounded-full hover:text-white hover:border-neutral-500 disabled:opacity-50 transition-colors"
          >
            {bulkOptimizing
              ? <><span className="animate-spin text-xs">⟳</span> Optimize ediliyor…</>
              : <><Image className="w-4 h-4" /> Görselleri Optimize Et</>}
          </button>
          <button onClick={() => setShowBulkImage(true)} className="flex items-center gap-2 px-3 py-2 bg-neutral-800 border border-neutral-700 text-neutral-400 text-sm rounded-full hover:text-white hover:border-neutral-500 transition-colors">
            <Images className="w-4 h-4" /> Toplu Görsel Üret
          </button>
          <button onClick={() => setShowBulkPortion(true)} className="flex items-center gap-2 px-3 py-2 bg-neutral-800 border border-neutral-700 text-neutral-400 text-sm rounded-full hover:text-white hover:border-neutral-500 transition-colors">
            <Scale className="w-4 h-4" /> Gramaj Doldur
          </button>
          <button onClick={() => setShowBulkContent(true)} className="flex items-center gap-2 px-3 py-2 bg-neutral-800 border border-neutral-700 text-neutral-400 text-sm rounded-full hover:text-white hover:border-neutral-500 transition-colors">
            <RefreshCw className="w-4 h-4" /> İçerik Yenile
          </button>
          <button onClick={() => setShowBulkAdd(true)} className="flex items-center gap-2 px-3 py-2 bg-neutral-800 border border-neutral-700 text-neutral-400 text-sm rounded-full hover:text-white hover:border-neutral-500 transition-colors">
            <ListPlus className="w-4 h-4" /> Toplu Ekle
          </button>
          <button onClick={() => setEditing({})} className="flex items-center gap-2 px-4 py-2 bg-white text-black text-sm font-semibold rounded-full hover:bg-neutral-100 transition-colors">
            <Plus className="w-4 h-4" /> Yeni Ürün
          </button>
        </div>
      </div>

      {/* ── Arama + kategori filtresi ── */}
      <div className="space-y-3">
        {/* Arama */}
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-neutral-500 pointer-events-none" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Ürün ara…"
            className="w-full bg-neutral-900 border border-neutral-700 text-white rounded-xl pl-9 pr-9 py-2.5 text-sm focus:outline-none focus:border-neutral-500 placeholder:text-neutral-600"
          />
          {search && (
            <button onClick={() => setSearch("")} className="absolute right-3 top-1/2 -translate-y-1/2 text-neutral-500 hover:text-white transition-colors">
              <X className="w-4 h-4" />
            </button>
          )}
        </div>

        {/* Kategori filtreleri */}
        <div className="flex gap-2 flex-wrap">
          <button onClick={() => setFilterCat("all")} className={`px-3 py-1.5 text-xs rounded-full transition-colors ${filterCat === "all" ? "bg-white text-black font-semibold" : "bg-neutral-800 text-neutral-400 hover:text-white"}`}>
            Tümü ({products.length})
          </button>
          {categories.map((c) => {
            const cnt = products.filter((p) => p.categoryId === c.id).length;
            return (
              <button key={c.id} onClick={() => setFilterCat(c.id)} className={`px-3 py-1.5 text-xs rounded-full transition-colors ${filterCat === c.id ? "bg-white text-black font-semibold" : "bg-neutral-800 text-neutral-400 hover:text-white"}`}>
                {c.translations.find((t) => t.languageCode === "tr")?.name ?? c.slug} ({cnt})
              </button>
            );
          })}
        </div>
      </div>

      {filteredProducts.length === 0 ? (
        <div className="text-center py-16 text-neutral-600">Henüz ürün yok</div>
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={filteredProducts.map((p) => p.id)} strategy={verticalListSortingStrategy}>
            <div className="space-y-2">
              {filteredProducts.map((product) => (
                <SortableProductRow
                  key={product.id} product={product} categories={categories}
                  viewCount={viewCounts[product.id]} onEdit={setEditing} onDelete={handleDelete}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      )}

      {editing !== false && (
        <ProductModal
          product={editing} categories={categories} languages={languages}
          onClose={() => setEditing(false)} onSave={load}
        />
      )}

      {showBulkAdd && (
        <BulkAddModal
          categories={categories}
          onClose={() => setShowBulkAdd(false)}
          onDone={() => { setShowBulkAdd(false); load(); }}
        />
      )}

      {showBulkImage && (
        <BulkImageModal
          products={products}
          categories={categories}
          onClose={() => setShowBulkImage(false)}
          onDone={() => { load(); }}
        />
      )}

      {showBulkContent && (
        <BulkContentModal
          products={products}
          categories={categories}
          languages={languages}
          onClose={() => setShowBulkContent(false)}
          onDone={() => { setShowBulkContent(false); load(); }}
        />
      )}

      {showBulkPortion && (
        <BulkPortionModal
          products={products}
          categories={categories}
          onClose={() => setShowBulkPortion(false)}
          onDone={() => { setShowBulkPortion(false); load(); }}
        />
      )}
    </div>
  );
}
