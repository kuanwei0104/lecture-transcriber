// 課程講義（PDF）中的圖片：取出有照片／插圖的頁面，畫單一主題卡、比較表時可以附上
import { audioStore } from "./audio.js";

const PDFJS = "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/";
const KEY = "handout:pages";       // 與音檔共用 IndexedDB：[{file, page, text, images: [{src, w, h}]}]
let pages = [];

async function loadPdfjs() {
  const pdfjs = await import(`${PDFJS}pdf.min.mjs`);
  pdfjs.GlobalWorkerOptions.workerSrc = `${PDFJS}pdf.worker.min.mjs`;
  return pdfjs;
}

const getObj = (page, id) => new Promise((resolve) => {
  const objs = id.startsWith("g_") ? page.commonObjs : page.objs;
  try { objs.get(id, resolve); } catch { resolve(null); }
});

// pdf.js 的圖片物件 → 白底 canvas
function toCanvas(img) {
  const w = img.width, h = img.height;
  const c = Object.assign(document.createElement("canvas"), { width: w, height: h });
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, w, h);
  if (img.bitmap) {
    ctx.drawImage(img.bitmap, 0, 0);
  } else if (img.data && (img.kind === 2 || img.kind === 3)) {
    const t = Object.assign(document.createElement("canvas"), { width: w, height: h });
    const id = t.getContext("2d").createImageData(w, h);
    if (img.kind === 3) id.data.set(img.data.subarray(0, w * h * 4));
    else for (let i = 0, j = 0; i < w * h; i++) {
      id.data[j++] = img.data[i * 3]; id.data[j++] = img.data[i * 3 + 1]; id.data[j++] = img.data[i * 3 + 2]; id.data[j++] = 255;
    }
    t.getContext("2d").putImageData(id, 0, 0);
    ctx.drawImage(t, 0, 0);       // 透明部分墊成白色
  } else {
    return null;
  }
  return c;
}

// 縮圖指紋：用來找出在很多頁重複出現的 logo
function fingerprint(c) {
  const t = Object.assign(document.createElement("canvas"), { width: 8, height: 8 });
  t.getContext("2d").drawImage(c, 0, 0, 8, 8);
  const d = t.getContext("2d").getImageData(0, 0, 8, 8).data;
  let s = `${c.width}x${c.height}:`;
  for (let i = 0; i < d.length; i += 4) s += ((d[i] + d[i + 1] + d[i + 2]) / 48 | 0).toString(16);
  return s;
}

// 裁掉四周空白、縮到最長邊 900px，輸出 JPEG
function finish(c) {
  const k = Math.min(1, 300 / Math.max(c.width, c.height));
  const sw = Math.max(1, Math.round(c.width * k)), sh = Math.max(1, Math.round(c.height * k));
  const t = Object.assign(document.createElement("canvas"), { width: sw, height: sh });
  t.getContext("2d").drawImage(c, 0, 0, sw, sh);
  const d = t.getContext("2d").getImageData(0, 0, sw, sh).data;
  let x0 = sw, y0 = sh, x1 = -1, y1 = -1;
  for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
    const i = (y * sw + x) * 4;
    if ((d[i] + d[i + 1] + d[i + 2]) / 3 < 240) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  }
  let [cx, cy, cw, ch] = [0, 0, c.width, c.height];
  if (x1 >= 0) {
    const pad = 10;
    cx = Math.max(0, x0 / k - pad); cy = Math.max(0, y0 / k - pad);
    cw = Math.min(c.width, (x1 + 1) / k + pad) - cx; ch = Math.min(c.height, (y1 + 1) / k + pad) - cy;
  }
  const s = Math.min(1, 900 / Math.max(cw, ch));
  const out = Object.assign(document.createElement("canvas"), { width: Math.round(cw * s), height: Math.round(ch * s) });
  out.getContext("2d").drawImage(c, cx, cy, cw, ch, 0, 0, out.width, out.height);
  return { src: out.toDataURL("image/jpeg", 0.85), w: out.width, h: out.height };
}

async function extractPdf(file, progress) {
  const pdfjs = await loadPdfjs();
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  const raw = [];                  // {page, text, imgs: [{fp, canvas}]}
  const pagesOf = new Map();
  for (let p = 1; p <= doc.numPages; p++) {
    progress?.(`擷取講義圖片 ${p}/${doc.numPages}…`);
    const page = await doc.getPage(p);
    const ops = await page.getOperatorList();
    const imgs = [];
    for (let i = 0; i < ops.fnArray.length; i++) {
      const fn = ops.fnArray[i];
      let img = null;
      if (fn === pdfjs.OPS.paintImageXObject) img = await getObj(page, ops.argsArray[i][0]);
      else if (fn === pdfjs.OPS.paintInlineImageXObject) img = ops.argsArray[i][0];
      // 略過太小的圖示與細長的結構式條帶
      if (!img || Math.min(img.width, img.height) < 200 || !(img.width / img.height >= 0.45 && img.width / img.height <= 2.3)) continue;
      const canvas = toCanvas(img);
      if (!canvas) continue;
      const fp = fingerprint(canvas);
      if (!pagesOf.has(fp)) pagesOf.set(fp, new Set());
      pagesOf.get(fp).add(p);
      imgs.push({ fp, canvas, area: img.width * img.height });
    }
    if (imgs.length) {
      const tc = await page.getTextContent();
      const text = tc.items.map((it) => it.str + (it.hasEOL ? "\n" : "")).join("");
      raw.push({ page: p, text: text.slice(0, 2000), imgs });
    }
    page.cleanup();
  }
  const out = [];
  for (const r of raw) {
    const seen = new Set();
    const keep = r.imgs.filter((im) => pagesOf.get(im.fp).size <= 2 && !seen.has(im.fp) && seen.add(im.fp))
      .sort((a, b) => b.area - a.area).slice(0, 2);
    if (keep.length) out.push({ file: file.name, page: r.page, text: r.text, images: keep.map((im) => finish(im.canvas)) });
  }
  await doc.destroy();
  return out;
}

const flat = (s) => String(s || "").replace(/\s+/g, "").toLowerCase();
const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// 找出講義中「主要在介紹這個名稱」的有圖頁面：標題行出現名稱最優先，其次看出現次數
function matchPage(names, exclude) {
  names = names.map((n) => String(n || "").trim()).filter((n) => n.length >= 2)
    // 出現在很多頁的名稱是章節名（例如每頁頁首的「辛溫解表藥」），不能用來找圖
    .filter((n) => pages.filter((p) => flat(p.text).includes(flat(n))).length <= 5);
  let best = null, bestScore = 0;
  for (const p of pages) {
    if (exclude.has(`${p.file}#${p.page}`) || !p.images?.length) continue;
    const f = flat(p.text);
    let score = 0;
    for (const n of names) {
      const c = f.split(flat(n)).length - 1;
      if (!c) continue;
      score += c;
      if (new RegExp(`^\\s*(?:[A-Za-z0-9一二三四五六七八九十]{1,3}[.、)]\\s*)?${reEsc(n)}`, "mi").test(p.text)) score += 10;
    }
    if (score > bestScore) { best = p; bestScore = score; }
  }
  return bestScore >= 3 ? best : null;
}

export const handoutImages = {
  get count() { return pages.length; },
  async load() {
    try {
      const v = await audioStore.get(KEY);
      pages = Array.isArray(v) ? v : [];
    } catch { pages = []; }
  },
  async clear() {
    pages = [];
    try { await audioStore.put(KEY, []); } catch { /* 無法存取 IndexedDB 就算了 */ }
  },
  async addPdf(file, progress) {
    const found = await extractPdf(file, progress);
    pages = pages.filter((p) => p.file !== file.name).concat(found);
    await audioStore.put(KEY, pages);
    return found.length;
  },
  // spec._img 的參照 → {src, w, h, page}
  resolve(ref) {
    const p = pages.find((x) => x.file === ref.file && x.page === ref.page);
    const im = p?.images?.[ref.idx || 0];
    return im ? { ...im, page: p.page } : null;
  },
  // 把講義圖片對應到單一主題卡／比較表的對象，記在 spec._img（只存參照，圖片留在本機）
  attach(spec, kind) {
    if (!pages.length) return spec;
    let targets;
    if (kind === "card") targets = [spec.subject || {}];
    else if (kind === "compare") targets = (spec.items || []).filter((i) => i && i.name).slice(0, 4);
    else return spec;
    const used = new Set();
    const refs = targets.map((t) => {
      const p = matchPage([t.name, t.alt], used);
      if (!p) return null;
      used.add(`${p.file}#${p.page}`);
      return { file: p.file, page: p.page, idx: 0 };
    });
    if (refs.some(Boolean)) spec._img = refs;
    return spec;
  },
};
