import { esc } from "./util.js";

// 把 Gemini 回傳的圖解結構畫成 SVG（1600×900，課堂講義風格）
const W = 1600;
const NAVY = "#1f4e79", CREAM = "#fdfcf7", GOLD = "#f39c12", GREY = "#c9d1db";
const FONT = `"Microsoft JhengHei","PingFang TC","Noto Sans TC","Heiti TC",sans-serif`;
const NO_BREAK_BEFORE = "）)，。、：；！？,.:;!?";

const charW = (c) => (c.codePointAt(0) > 0x2e80 ? 1.0 : 0.56);
const strW = (s) => [...s].reduce((a, c) => a + charW(c), 0);

// 依字寬折行：中日韓字 = 1em，其餘約 0.56em；英數字詞不從中間斷開
export function wrap(text, maxEm) {
  const lines = [];
  let cur = "", w = 0;
  for (const tok of String(text ?? "").match(/[A-Za-z0-9_.'’\-]+|[\s\S]/gu) || []) {
    const tw = strW(tok);
    if (w + tw > maxEm && cur && !NO_BREAK_BEFORE.includes(tok)) {
      lines.push(cur.trimEnd()); cur = ""; w = 0;
      if (tok === " ") continue;
    }
    if (tw > maxEm) {
      for (const c of tok) {
        if (w + charW(c) > maxEm && cur) { lines.push(cur); cur = ""; w = 0; }
        cur += c; w += charW(c);
      }
      continue;
    }
    cur += tok; w += tw;
  }
  if (cur.trim()) lines.push(cur.trimEnd());
  return lines.length ? lines : [""];
}

/* ───────────── 圖型：重點整理／流程／單一主題卡／比較表 ───────────── */
const INK = "#22313f", DIM = "#6b7785", LINE = "#d5dbe3", PAPER = "#ffffff";
const WARM = "#c0512f", WARM_BG = "#fbeee8";
// 比較表每一欄的顏色：[主色, 淺底, 邊框]
const ITEM_COLORS = [["#c0512f", "#fbeee8", "#f3d2c4"], ["#1f7a8c", "#e6f3f5", "#c3e3e8"],
                     ["#6a4c93", "#f1ecf7", "#dacfe9"], ["#2e7d32", "#e9f4ea", "#c8e3ca"]];
const arr = (x) => (Array.isArray(x) ? x : []);
const isObj = (x) => x && typeof x === "object" && !Array.isArray(x);

// Gemini 選的圖型；資料不足以畫該圖型時退回「重點整理」
export function diagramType(spec) {
  const t = String(spec?.type || "").trim().toLowerCase();
  const items = arr(spec.items).filter((i) => isObj(i) && i.name);
  const rows = arr(spec.rows).filter((r) => isObj(r) && arr(r.values).length);
  const fields = arr(spec.fields).filter((f) => isObj(f) && f.value);
  const steps = arr(spec.steps).filter((s) => isObj(s) && s.title);
  if (t === "compare" && items.length >= 2 && rows.length >= 2) return t;
  if (t === "card" && isObj(spec.subject) && spec.subject.name && fields.length >= 2) return t;
  if (t === "process" && steps.length >= 2) return t;
  return "points";
}

// 繪圖指令（文字的 y 是基線），排完版知道總高度後再輸出 SVG
class Sketch {
  constructor() { this.el = []; }
  rect(x, y, w, h, fill, stroke = "none", lw = 0, r = 0) {
    this.el.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${fill}" stroke="${stroke}" stroke-width="${lw}"/>`);
  }
  text(x, y, s, px, color, bold = false, anchor = "start") {
    this.el.push(`<text x="${x}" y="${y}" font-size="${px}" fill="${color}" text-anchor="${anchor}"${bold ? ' font-weight="700"' : ""}>${esc(s)}</text>`);
  }
  line(x1, y1, x2, y2, color, lw = 1) {
    this.el.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="${lw}"/>`);
  }
  circle(cx, cy, r, fill) { this.el.push(`<circle cx="${cx}" cy="${cy}" r="${r}" fill="${fill}"/>`); }
  image(src, x, y, w, h) { this.el.push(`<image href="${src}" x="${x}" y="${y}" width="${w}" height="${h}"/>`); }
  svg(H, label) {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${Math.round(H)}" font-family='${FONT}' role="img" aria-label="${esc(label)}">
<rect width="${W}" height="${Math.round(H)}" fill="${CREAM}"/>
${this.el.join("\n")}
</svg>`;
  }
}

const isEnSpec = (spec) => !/[㐀-鿿]/.test(JSON.stringify(spec, (k, v) => (k.startsWith("_") ? undefined : v)));
const paraH = (s, px, maxW, lh = 1.45) => wrap(s, maxW / px).length * px * lh;
function para(sk, x, y, s, px, maxW, color = INK, bold = false, lh = 1.45, anchor = "start") {
  const lines = wrap(s, maxW / px);
  lines.forEach((ln, i) => sk.text(x, y + i * px * lh, ln, px, color, bold, anchor));
  return lines.length * px * lh;
}
function paraMid(sk, x, top, h, s, px, maxW, color = INK, bold = false, lh = 1.45, anchor = "start") {
  const n = wrap(s, maxW / px).length;
  para(sk, x, top + (h - ((n - 1) * px * lh + px)) / 2 + px * 0.86, s, px, maxW, color, bold, lh, anchor);
}
function header(sk, title, subtitle, note = "") {
  sk.rect(40, 28, 1520, 108, NAVY, "none", 0, 16);
  title = String(title || "課程圖解");
  const px = strW(title) * 42 <= 1440 ? 42 : Math.max(28, Math.floor(1440 / Math.max(strW(title), 1)));
  sk.text(76, 86, title, px, "#fff", true);
  if (subtitle) sk.text(78, 120, wrap(subtitle, 1100 / 20)[0], 20, "#cfe0f2");
  if (note) sk.text(1524, 120, note, 18, "#cfe0f2", false, "end");
}
function noteBox(sk, y, note, color = "#7a5200", bg = "#fff7e6", edge = "#e0a32e") {
  note = String(note || "").trim();
  if (!note) return y;
  const h = paraH(note, 22, 1460) + 30;
  sk.rect(40, y, 1520, h, bg, edge, 1.5, 12);
  paraMid(sk, 68, y, h, note, 22, 1460, color, true);
  return y + h + 28;
}
const fit = (img, bw, bh) => { const s = Math.min(bw / img.w, bh / img.h); return [img.w * s, img.h * s]; };

function layoutCompare(spec, ts, imgs) {
  const items = arr(spec.items).filter((i) => isObj(i) && i.name).slice(0, 4);
  const n = items.length;
  const rows = arr(spec.rows).filter(isObj).slice(0, 9).map((r) => {
    const vals = arr(r.values).map(String).slice(0, n);
    while (vals.length < n) vals.push("—");
    return [String(r.label ?? ""), vals];
  });
  const isEn = isEnSpec(spec);
  const pics = items.map((_, i) => imgs[i] || null);
  const pages = [...new Set(pics.filter(Boolean).map((p) => p.page))].sort((a, b) => a - b);
  let note = ts;
  if (pages.length) note = (isEn ? `Images: handout p.${pages.join(", ")}` : `附圖：講義 p.${pages.join("、")}`) + (ts ? `  ·  ${ts}` : "");
  const sk = new Sketch();
  header(sk, spec.title_zh, spec.subtitle_en, note);
  const x0 = 40, lw = n >= 3 ? 220 : 250, cw = (1520 - lw) / n;
  const px = n === 2 ? 22 : n === 3 ? 21 : 19;
  let y = 168;
  if (pics.some(Boolean)) {
    // 每一欄一張附圖卡片；沒對應到圖片的欄位用名稱大字代替
    const cardH = 236, imgH = 150;
    items.forEach((it, i) => {
      const [color, bg, soft] = ITEM_COLORS[i % 4];
      const cx = x0 + lw + i * cw;
      sk.rect(cx + 8, y, cw - 16, cardH, PAPER, soft, 2, 14);
      if (pics[i]) {
        const [iw, ih] = fit(pics[i], cw - 40, imgH);
        sk.image(pics[i].src, cx + (cw - iw) / 2, y + 12 + (imgH - ih) / 2, iw, ih);
      } else {
        sk.rect(cx + 20, y + 12, cw - 40, imgH, bg, "none", 0, 10);
        sk.text(cx + cw / 2, y + 12 + imgH / 2 + 22, String(it.name).slice(0, 6), 60, soft, true, "middle");
      }
      sk.text(cx + cw / 2, y + 196, wrap(it.name, (cw - 30) / 30)[0], 30, color, true, "middle");
      if (it.alt) sk.text(cx + cw / 2, y + 222, wrap(it.alt, (cw - 30) / 15)[0], 15, DIM, false, "middle");
    });
    y += cardH + 16;
  } else {
    const headH = items.some((it) => it.alt) ? 86 : 72;
    items.forEach((it, i) => {
      const cx = x0 + lw + i * cw;
      sk.rect(cx + 4, y, cw - 8, headH, ITEM_COLORS[i % 4][0], "none", 0, 12);
      const hp = strW(String(it.name)) * 28 < cw - 30 ? 28 : 22;
      sk.text(cx + cw / 2, y + (it.alt ? 40 : 46), wrap(it.name, (cw - 30) / hp)[0], hp, "#fff", true, "middle");
      if (it.alt) sk.text(cx + cw / 2, y + 70, wrap(it.alt, (cw - 30) / 16)[0], 16, "#f3f6fa", false, "middle");
    });
    y += headH + 12;
  }
  const tableTop = y;
  rows.forEach(([label, vals], k) => {
    const same = n > 1 && new Set(vals).size === 1 && vals[0] !== "—";      // 共同點用粗體
    const h = Math.max(62, Math.max(...vals.map((v) => paraH(v, px, cw - 48)), paraH(label, 21, lw - 40)) + 26);
    if (k % 2 === 0) sk.rect(x0, y, lw + n * cw, h, "#f2f4f7");
    paraMid(sk, x0 + 22, y, h, label, 21, lw - 40, NAVY, true);
    vals.forEach((v, i) => paraMid(sk, x0 + lw + i * cw + 24, y, h, v, px, cw - 48, INK, same));
    sk.line(x0, y + h, x0 + lw + n * cw, y + h, LINE, 1);
    y += h;
  });
  for (let i = 1; i < n; i++) sk.line(x0 + lw + i * cw, tableTop, x0 + lw + i * cw, y, LINE, 2);
  y = noteBox(sk, y + 26, spec.note, NAVY, "#eef4fb", NAVY);
  return sk.svg(y + 12, spec.title_zh || "比較表");
}

function layoutCard(spec, ts, imgs) {
  const subj = spec.subject || {};
  const fields = arr(spec.fields).filter((f) => isObj(f) && f.value).slice(0, 9)
    .map((f) => [String(f.label ?? ""), String(f.value)]);
  const isEn = isEnSpec(spec);
  const img = imgs[0] || null;
  const name = String(subj.name || spec.title_zh || "");
  const title = name + (subj.alt && strW(name + subj.alt) < 34 ? `  ${subj.alt}` : "");
  const sk = new Sketch();
  header(sk, title, subj.tagline || spec.subtitle_en, ts);
  const y0 = 168;
  let x = 40, labW = 210;
  if (img) {
    sk.rect(40, y0, 600, 470, PAPER, LINE, 1.5, 16);
    const [iw, ih] = fit(img, 560, 410);
    sk.image(img.src, 40 + (600 - iw) / 2, y0 + 18 + (410 - ih) / 2, iw, ih);
    sk.text(340, y0 + 456, isEn ? `Handout p.${img.page}` : `講義第 ${img.page} 頁附圖`, 17, DIM, false, "middle");
    x = 672; labW = 150;
  }
  const fw = 1560 - x;
  const warn = /禁忌|注意|副作用|警告|毒|caution|contraindic|warning|side effect/i;
  let y = y0;
  for (const [label, value] of fields) {
    const hot = warn.test(label);
    const h = Math.max(58, paraH(value, 22, fw - labW - 44) + 22, paraH(label, 20, labW - 20) + 18);
    sk.rect(x, y, fw, h, PAPER, LINE, 1, 10);
    sk.rect(x, y, labW, h, hot ? WARM_BG : "#eef4fb", "none", 0, 10);
    paraMid(sk, x + labW / 2, y, h, label, 20, labW - 20, hot ? WARM : NAVY, true, 1.45, "middle");
    paraMid(sk, x + labW + 22, y, h, value, 22, fw - labW - 44, INK);
    y += h + 10;
  }
  y = Math.max(y + 16, img ? y0 + 470 + 26 : 0);
  y = noteBox(sk, y, spec.note);
  return sk.svg(y + 12, name || "主題卡");
}

function layoutProcess(spec, ts) {
  const steps = arr(spec.steps).filter((s) => isObj(s) && s.title).slice(0, 7);
  const formula = String(spec.formula || "").trim();
  const isEn = isEnSpec(spec);
  const sk = new Sketch();
  header(sk, spec.title_zh, spec.subtitle_en, ts);
  let y = 172;
  const concept = String(spec.concept_zh || "").trim();
  if (concept) y += para(sk, 44, y + 22 * 0.86, concept, 22, 1500, DIM) + 18;
  const cx = 96, bx = 150, bw = 1560 - bx;
  const boxes = steps.map((s) => {
    const t = String(s.title), d = String(s.detail || "").trim();
    const th = paraH(t, 27, bw - 56, 1.3), dh = d ? paraH(d, 22, bw - 56) : 0;
    const h = Math.max(84, 22 + th + (d ? 8 + dh : 0) + 18);
    const box = { y, h, t, d, th };
    y += h + 22;
    return box;
  });
  if (boxes.length) sk.line(cx, boxes[0].y + 42, cx, boxes.at(-1).y + 42, "#b8c7d9", 4);   // 連接線在圓圈底下
  boxes.forEach((b, i) => {
    sk.rect(bx, b.y, bw, b.h, PAPER, LINE, 1.5, 14);
    sk.rect(bx, b.y, 8, b.h, GOLD, "none", 0, 4);
    sk.circle(cx, b.y + 42, 28, NAVY);
    sk.text(cx, b.y + 52, String(i + 1), 28, "#fff", true, "middle");
    para(sk, bx + 30, b.y + 22 + 27 * 0.86, b.t, 27, bw - 56, NAVY, true, 1.3);
    if (b.d) para(sk, bx + 30, b.y + 22 + b.th + 8 + 22 * 0.86, b.d, 22, bw - 56, INK);
  });
  y += 6;
  if (formula) {
    const fh = paraH(formula, 28, 1460, 1.3) + 66;
    sk.rect(40, y, 1520, fh, "#f4ecf7", "#6a1b9a", 2, 14);
    sk.text(68, y + 34, isEn ? "Formula" : "公式", 20, "#6a1b9a", true);
    para(sk, 68, y + 46 + 28 * 0.86, formula, 28, 1460, "#4a148c", true, 1.3);
    y += fh + 28;
  }
  y = noteBox(sk, y, spec.note);
  return sk.svg(y + 12, spec.title_zh || "流程");
}

// images：把 spec._img 的參照換成 {src, w, h, page}；找不到（例如在另一台裝置）就不附圖
export function renderDiagram(spec, ts = "", { images = () => null } = {}) {
  const kind = diagramType(spec);
  const imgs = arr(spec._img).map((ref) => (ref ? images(ref) : null));
  try {
    if (kind === "compare") return layoutCompare(spec, ts, imgs);
    if (kind === "card") return layoutCard(spec, ts, imgs);
    if (kind === "process") return layoutProcess(spec, ts);
  } catch (e) {
    console.warn("[Diagram]", kind, e);       // 新圖型畫不出來就退回重點整理
  }
  return renderPoints(spec, ts);
}

function renderPoints(spec, ts = "") {
  const el = [];
  const text = (x, y, s, px, color, { bold = false, anchor = "start", baseline = "hanging" } = {}) =>
    el.push(`<text x="${x}" y="${y}" font-size="${px}" fill="${color}" text-anchor="${anchor}" dominant-baseline="${baseline}"${bold ? ' font-weight="700"' : ""}>${esc(s)}</text>`);
  const rect = (x, y, w, h, fill, stroke = "none", sw = 1.5, r = 14) =>
    el.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"/>`);

  let panels = (Array.isArray(spec.panels) ? spec.panels : []).filter((p) => p && typeof p === "object").slice(0, 3);
  const flow = (Array.isArray(spec.flow) ? spec.flow : []).map(String).filter((s) => s.trim()).slice(0, 5);
  const formula = String(spec.formula || "").trim();
  // 內容沒有中文（例如匯出 English 版時）就改用英文標籤
  const isEn = !/[㐀-鿿]/.test(JSON.stringify(spec));
  const [flowLabel, formulaLabel] = isEn ? ["Process / Relationship", "Formula"] : ["流程 / 關係", "公式"];
  if (!panels.length) panels = [{ heading: "重點摘要", bullets: wrap(spec.concept_zh || "", 40).slice(0, 6) }];

  const top = 178;
  const rightW = flow.length || formula ? 470 : 0;
  const leftX = 40, leftW = W - 80 - (rightW ? rightW + 30 : 0);
  const gap = 26, n = panels.length, pw = (leftW - gap * (n - 1)) / n;

  // 先算內容需要多高，圖的高度再跟著內容走（避免整片空白）
  const heads = panels.map((p) => wrap(p.heading || "", (pw - 48) / 34).slice(0, 2));
  const bulletsAll = panels.map((p) => (Array.isArray(p.bullets) ? p.bullets : []).map(String).slice(0, 5));
  let px, lh, bgap, wraps, panelsH;
  for (px of [30, 28, 26, 24, 22, 20]) {
    lh = px * 1.45; bgap = px * 0.8;
    wraps = bulletsAll.map((bl) => bl.map((b) => wrap(b, (pw - 70) / px)));
    panelsH = Math.max(...heads.map((h, i) =>
      30 + h.length * 46 + 10 + wraps[i].reduce((a, w) => a + w.length * lh + bgap, 0) + 24));
    if (panelsH <= 1180) break;
  }
  const flowBh = 100, arrowGap = 34;
  let rightH = flow.length ? 50 + flow.length * flowBh + (flow.length - 1) * arrowGap : 0;
  if (formula) rightH += flow.length ? 150 : 130;
  const H = Math.round(Math.min(1500, Math.max(360, top + Math.max(panelsH, rightH, 160) + 40)));
  const bottom = H - 40;

  // 標題列
  rect(40, 28, W - 80, 118, NAVY);
  text(76, 48, String(spec.title_zh || "課程圖解").slice(0, 28), 44, "#fff", { bold: true });
  if (spec.subtitle_en) text(78, 106, String(spec.subtitle_en).slice(0, 80), 22, "#cfe0f2");
  if (ts) text(W - 76, 106, ts, 20, "#cfe0f2", { anchor: "end" });

  // 左側重點面板
  panels.forEach((p, i) => {
    const x = leftX + i * (pw + gap);
    rect(x, top, pw, bottom - top, "#fff", GREY);
    rect(x, top, pw, 12, GOLD, "none", 0, 6);
    let y = top + 30;
    for (const ln of heads[i]) { text(x + 24, y, ln, 34, NAVY, { bold: true }); y += 46; }
    y += 10;
    for (const bl of wraps[i]) {
      if (y + lh > bottom - 16) break;
      el.push(`<circle cx="${x + 31}" cy="${y + px * 0.55}" r="5" fill="${GOLD}"/>`);
      for (const ln of bl) {
        if (y + lh > bottom - 16) break;
        text(x + 46, y, ln, px, "#2c3e50"); y += lh;
      }
      y += bgap;
    }
  });

  // 右側流程與公式
  if (rightW) {
    const rx = W - 40 - rightW, cx = rx + rightW / 2;
    const flowBottom = bottom - (formula ? 150 : 0);
    if (flow.length) {
      text(cx, top, flowLabel, 28, NAVY, { bold: true, anchor: "middle" });
      const areaTop = top + 50, k = flow.length, arrow = 34;
      const bh = Math.min(110, (flowBottom - areaTop - arrow * (k - 1)) / k);
      flow.forEach((step, i) => {
        const by = areaTop + i * (bh + arrow);
        rect(rx + 20, by, rightW - 40, bh, "#eaf2fb", NAVY, 2, 12);
        const lines = wrap(step, (rightW - 80) / 27).slice(0, 2);
        let ly = by + bh / 2 - (lines.length - 1) * 18;
        for (const ln of lines) { text(cx, ly, ln, 27, NAVY, { bold: true, anchor: "middle", baseline: "central" }); ly += 36; }
        if (i < k - 1) {
          const ay = by + bh;
          el.push(`<line x1="${cx}" y1="${ay + 4}" x2="${cx}" y2="${ay + arrow - 12}" stroke="${GOLD}" stroke-width="4"/>`);
          el.push(`<path d="M${cx - 10} ${ay + arrow - 14} L${cx + 10} ${ay + arrow - 14} L${cx} ${ay + arrow - 3} z" fill="${GOLD}"/>`);
        }
      });
    }
    if (formula) {
      const fy = flow.length ? bottom - 130 : top;
      rect(rx, fy, rightW, 130, "#f4ecf7", "#6a1b9a", 2);
      text(rx + 20, fy + 14, formulaLabel, 22, "#6a1b9a", { bold: true });
      let ly = fy + 52;
      for (const ln of wrap(formula, (rightW - 40) / 26).slice(0, 2)) { text(rx + 20, ly, ln, 28, "#4a148c", { bold: true }); ly += 36; }
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" font-family='${FONT}' role="img" aria-label="${esc(spec.title_zh || "課程圖解")}">
<rect width="${W}" height="${H}" fill="${CREAM}"/>
${el.join("\n")}
</svg>`;
}

/* ───────────── 心智圖（左右分支，輸出 SVG） ───────────── */
const MM_COLORS = ["#2980b9", "#16a085", "#8e44ad", "#c0392b", "#d68910", "#0b7285", "#6c3aa0"];
const MM_PAD = 40;

function mmBox(text, px, maxEm, { padX = 16, padY = 10 } = {}) {
  const lines = wrap(text, maxEm);
  const w = Math.max(...lines.map(strW)) * px + padX * 2;
  const lh = px * 1.35;
  return { lines, px, lh, w, h: lines.length * lh + padY * 2 };
}

// Gemini 偶爾回傳不同形狀（分支是陣列或字串），先統一格式
function mmText(x) {
  if (x && typeof x === "object" && !Array.isArray(x)) {
    for (const k of ["title", "text", "name", "label", "value", "point"]) if (x[k]) return String(x[k]);
    const v = Object.values(x).find((y) => typeof y === "string" || typeof y === "number");
    return v == null ? "" : String(v);
  }
  if (Array.isArray(x)) return x.map(mmText).filter(Boolean).join("、");
  return x == null ? "" : String(x);
}

export function mmNormalize(tree) {
  if (Array.isArray(tree)) tree = { branches: tree };
  if (!tree || typeof tree !== "object") tree = {};
  const root = mmText(tree.root || tree.title || tree.topic || "");
  let raw = tree.branches || tree.children || tree.nodes || [];
  if (!Array.isArray(raw)) raw = [raw];
  const branches = [];
  for (const b of raw) {
    let title, kids;
    if (b && typeof b === "object" && !Array.isArray(b)) {
      title = mmText(b);
      kids = b.children || b.items || b.points || b.nodes || [];
    } else if (Array.isArray(b) && b.length) {
      title = mmText(b[0]); kids = b.slice(1);
    } else {
      title = mmText(b); kids = [];
    }
    if (!Array.isArray(kids)) kids = [kids];
    const children = kids.flat().map(mmText).filter(Boolean);
    if (title || children.length) branches.push({ title, children });
  }
  return { root, branches };
}

export function renderMindmap(rawTree, { fontFamily = FONT } = {}) {
  const tree = mmNormalize(rawTree);
  const root = mmBox(tree.root, 34, 14, { padX: 26, padY: 16 });
  const branches = tree.branches.slice(0, 8).map((b, i) => {
    const box = mmBox(b.title, 26, 12, { padX: 18, padY: 12 });
    const children = b.children.slice(0, 6).map((c) => mmBox(c, 20, 18));
    const gapY = 14;
    const childrenH = children.reduce((a, c) => a + c.h + gapY, -gapY);
    return { ...box, color: MM_COLORS[i % MM_COLORS.length], children, childrenH: Math.max(0, childrenH),
             h2: Math.max(box.h, Math.max(0, childrenH)) };
  });

  // 依序把分支放到目前較短的一側，讓左右高度平衡
  const gapBranch = 34, gapX = 70;
  const sides = [[], []];                                          // [右, 左]
  const used = [0, 0];
  branches.forEach((b) => {
    const s = used[0] <= used[1] ? 0 : 1;
    sides[s].push(b);
    used[s] += b.h2 + gapBranch;
  });
  const sideH = sides.map((s) => s.reduce((a, b) => a + b.h2 + gapBranch, -gapBranch));
  const height = Math.max(root.h + 80, ...sideH.map((h) => Math.max(h, 0)) ) + MM_PAD * 2;
  const cy = height / 2;

  const el = [];
  const put = (box, x, y, { fill, stroke, color = "#fff", bold = false, rx = 12 }) => {
    el.push(`<rect x="${x}" y="${y}" width="${box.w}" height="${box.h}" rx="${rx}" fill="${fill}" stroke="${stroke || "none"}" stroke-width="2"/>`);
    let ty = y + (box.h - box.lines.length * box.lh) / 2 + box.lh / 2;
    for (const ln of box.lines) {
      el.push(`<text x="${x + box.w / 2}" y="${ty}" font-size="${box.px}" fill="${color}" text-anchor="middle" dominant-baseline="central"${bold ? ' font-weight="700"' : ""}>${esc(ln)}</text>`);
      ty += box.lh;
    }
  };
  const curve = (x1, y1, x2, y2, color) => {
    const mx = (x1 + x2) / 2;
    el.push(`<path d="M${x1} ${y1} C${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}" fill="none" stroke="${color}" stroke-width="3" stroke-linecap="round"/>`);
  };

  // 先以中心為原點排版，最後再平移
  const rootX = -root.w / 2, rootY = cy - root.h / 2;
  let minX = rootX, maxX = rootX + root.w;

  sides.forEach((side, s) => {
    const dir = s === 0 ? 1 : -1;                    // 1 = 右，-1 = 左
    let y = cy - (side.reduce((a, b) => a + b.h2 + gapBranch, -gapBranch)) / 2;
    for (const b of side) {
      const bx = dir === 1 ? root.w / 2 + gapX : -root.w / 2 - gapX - b.w;
      const by = y + (b.h2 - b.h) / 2;
      curve(dir === 1 ? root.w / 2 : -root.w / 2, cy, dir === 1 ? bx : bx + b.w, by + b.h / 2, b.color);
      put(b, bx, by, { fill: b.color, bold: true });
      minX = Math.min(minX, bx); maxX = Math.max(maxX, bx + b.w);

      let cyy = y + (b.h2 - b.childrenH) / 2;
      for (const c of b.children) {
        const cx = dir === 1 ? bx + b.w + gapX : bx - gapX - c.w;
        curve(dir === 1 ? bx + b.w : bx, by + b.h / 2, dir === 1 ? cx : cx + c.w, cyy + c.h / 2, b.color);
        put(c, cx, cyy, { fill: "#fff", stroke: b.color, color: "#2c3e50", rx: 10 });
        minX = Math.min(minX, cx); maxX = Math.max(maxX, cx + c.w);
        cyy += c.h + 14;
      }
      y += b.h2 + gapBranch;
    }
  });

  put(root, rootX, rootY, { fill: NAVY, bold: true, rx: 18 });

  const width = maxX - minX + MM_PAD * 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${minX - MM_PAD} 0 ${width} ${height}" font-family='${fontFamily}' role="img" aria-label="${esc(tree.root || "mind map")}">
<rect x="${minX - MM_PAD}" y="0" width="${width}" height="${height}" fill="${CREAM}"/>
${el.join("\n")}
</svg>`;
}
