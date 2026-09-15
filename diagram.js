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
