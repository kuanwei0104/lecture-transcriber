import { esc } from "./util.js";

// 把 Gemini 回傳的圖解結構畫成 SVG（1600×900，課堂講義風格）
const W = 1600, H = 900;
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

export function renderDiagram(spec, ts = "") {
  const el = [];
  const text = (x, y, s, px, color, { bold = false, anchor = "start", baseline = "hanging" } = {}) =>
    el.push(`<text x="${x}" y="${y}" font-size="${px}" fill="${color}" text-anchor="${anchor}" dominant-baseline="${baseline}"${bold ? ' font-weight="700"' : ""}>${esc(s)}</text>`);
  const rect = (x, y, w, h, fill, stroke = "none", sw = 1.5, r = 14) =>
    el.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"/>`);

  // 標題列
  rect(40, 28, W - 80, 118, NAVY);
  text(76, 48, String(spec.title_zh || "課程圖解").slice(0, 28), 44, "#fff", { bold: true });
  if (spec.subtitle_en) text(78, 106, String(spec.subtitle_en).slice(0, 80), 22, "#cfe0f2");
  if (ts) text(W - 76, 106, ts, 20, "#cfe0f2", { anchor: "end" });

  let panels = (Array.isArray(spec.panels) ? spec.panels : []).filter((p) => p && typeof p === "object").slice(0, 3);
  const flow = (Array.isArray(spec.flow) ? spec.flow : []).map(String).filter((s) => s.trim()).slice(0, 5);
  const formula = String(spec.formula || "").trim();
  // 內容沒有中文（例如匯出 English 版時）就改用英文標籤
  const isEn = !/[㐀-鿿]/.test(JSON.stringify(spec));
  const [flowLabel, formulaLabel] = isEn ? ["Process / Relationship", "Formula"] : ["流程 / 關係", "公式"];
  if (!panels.length) panels = [{ heading: "重點摘要", bullets: wrap(spec.concept_zh || "", 40).slice(0, 6) }];

  const top = 178, bottom = H - 40;
  const rightW = flow.length || formula ? 470 : 0;
  const leftX = 40, leftW = W - 80 - (rightW ? rightW + 30 : 0);

  // 左側重點面板
  const gap = 26, n = panels.length, pw = (leftW - gap * (n - 1)) / n;
  panels.forEach((p, i) => {
    const x = leftX + i * (pw + gap);
    rect(x, top, pw, bottom - top, "#fff", GREY);
    rect(x, top, pw, 12, GOLD, "none", 0, 6);
    let y = top + 30;
    for (const ln of wrap(p.heading || "", (pw - 48) / 34).slice(0, 2)) { text(x + 24, y, ln, 34, NAVY, { bold: true }); y += 46; }
    y += 10;
    const bullets = (Array.isArray(p.bullets) ? p.bullets : []).map(String).slice(0, 5);
    let px, lh, bgap, wrapped;
    for (px of [30, 28, 26, 24, 22, 20]) {         // 挑選放得下的最大字級
      lh = px * 1.45; bgap = px * 0.8;
      wrapped = bullets.map((b) => wrap(b, (pw - 70) / px));
      const need = wrapped.reduce((a, bl) => a + bl.length * lh + bgap, 0);
      if (y + need <= bottom - 20) break;
    }
    for (const bl of wrapped) {
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

function mmNormalize(tree) {
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
