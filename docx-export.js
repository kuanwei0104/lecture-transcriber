// Word（.docx）匯出：可以直接編輯的版本。docx 套件只在匯出 Word 時才載入
import { renderDiagram, mmNormalize } from "./diagram.js";

const DOCX = "https://cdn.jsdelivr.net/npm/docx@9.11.0/+esm";
const IMG_W = 620;          // 圖片寬度（px，約 16.4 cm，A4 左右各留 2 cm）
const IMG_MAX_H = 860;      // 太高的圖縮到一頁放得下

// SVG 圖解 → PNG（Word 不支援 SVG）；失敗回傳 null，只留圖說
async function svgToPng(svg, width = 1600) {
  const m = svg.match(/viewBox="([-\d.]+) ([-\d.]+) ([\d.]+) ([\d.]+)"/);
  if (!m) return null;
  const h = Math.round(width * Number(m[4]) / Number(m[3]));
  const src = svg.replace("<svg ", `<svg width="${width}" height="${h}" `);
  try {
    const img = new Image();
    img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(src);
    await img.decode();
    const c = Object.assign(document.createElement("canvas"), { width, height: h });
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, width, h);
    ctx.drawImage(img, 0, 0, width, h);
    const blob = await new Promise((r) => c.toBlob(r, "image/png"));
    return { data: new Uint8Array(await blob.arrayBuffer()), w: width, h };
  } catch (e) {
    console.warn("[Docx image]", e);
    return null;
  }
}

/**
 * d：app.js prepareExport() 整理好的內容；opts.images：講義圖片解析；opts.q：課後提問標籤
 * 回傳 .docx 的 Blob
 */
export async function buildDocx(d, { images, q }) {
  const { Document, Packer, Paragraph, TextRun, HeadingLevel, ImageRun, AlignmentType, BorderStyle } = await import(DOCX);
  const { T, items, warning, tree, label, lines } = d;

  // **粗體**、`程式碼` → Word 的文字格式
  const runs = (text, opts = {}) => String(text).split(/(\*\*[^*]+\*\*|`[^`]+`)/).filter(Boolean).map((p) =>
    p.startsWith("**") && p.endsWith("**") && p.length > 4 ? new TextRun({ text: p.slice(2, -2), bold: true, ...opts })
    : p.startsWith("`") && p.endsWith("`") && p.length > 2 ? new TextRun({ text: p.slice(1, -1), font: "Consolas", ...opts })
    : new TextRun({ text: p, ...opts }));
  const small = (text, extra = {}) => new Paragraph({ children: [new TextRun({ text, size: 18, color: "7F8C8D", ...extra })] });
  const heading = (text, level = HeadingLevel.HEADING_1) => new Paragraph({ heading: level, children: runs(String(text).replace(/\*\*/g, "")) });

  // 與 mdToHtml 相同的輕量 markdown
  function mdParas(md) {
    const out = [];
    for (const raw of String(md).split("\n")) {
      const s = raw.trimEnd();
      if (!s.trim()) continue;
      let m;
      if ((m = s.match(/^(#{1,6})\s+(.+)$/))) {
        out.push(heading(m[2], m[1].length <= 2 ? HeadingLevel.HEADING_1 : HeadingLevel.HEADING_2)); continue;
      }
      if (s.trimStart().startsWith(">")) {
        out.push(new Paragraph({ children: runs(s.trimStart().slice(1).trim(), { color: "7D6608" }), indent: { left: 240 },
          shading: { fill: "FDF6E3" }, border: { left: { style: BorderStyle.SINGLE, size: 18, color: "F39C12", space: 8 } } }));
        continue;
      }
      if ((m = s.match(/^(\s*)[-•*]\s+(.+)$/))) {
        out.push(new Paragraph({ bullet: { level: m[1].length >= 2 ? 1 : 0 }, children: runs(m[2]) })); continue;
      }
      if ((m = s.match(/^\s*(\d+[.、)])\s+(.+)$/))) {
        // 編號直接寫成文字：Word 的自動編號會跨段落一路接下去
        out.push(new Paragraph({ indent: { left: 340 }, children: runs(`${m[1]} ${m[2]}`) })); continue;
      }
      out.push(new Paragraph({ children: runs(s.trim()), indent: s.startsWith("    ") ? { left: 680 } : undefined }));
    }
    return out;
  }

  const children = [
    new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun(`${T.title} ${label}`)] }),
    small(`${T.exported}${new Date().toLocaleString(T.locale)}`),
  ];
  if (warning) children.push(small(`⚠ ${warning}`, { color: "B05A00" }));
  if (tree) {
    const t = mmNormalize(tree);
    children.push(heading(T.mindmap));
    children.push(new Paragraph({ bullet: { level: 0 }, children: [new TextRun({ text: t.root, bold: true })] }));
    for (const b of t.branches) {
      children.push(new Paragraph({ bullet: { level: 1 }, children: [new TextRun({ text: b.title, bold: true })] }));
      for (const c of b.children) children.push(new Paragraph({ bullet: { level: 2 }, children: [new TextRun(String(c))] }));
    }
  }
  for (const b of items) {
    if (b.kind === "narr") {
      children.push(small(`⏱ ${b.ts}`), ...mdParas(b.md));
    } else if (b.kind === "q") {
      const L = q.labels;
      children.push(heading(`💬 ${L.title} ${b.qts}`));
      if (b.data.summary) children.push(new Paragraph({ children: runs(`**${L.summary}${L.sep}**${b.data.summary}`) }));
      q.list(b.data).forEach((x, i) => {
        children.push(new Paragraph({ indent: { left: 340 }, children: runs(`${i + 1}. ${x.q}`) }));
        if (x.context) children.push(new Paragraph({ indent: { left: 680 },
          children: [new TextRun({ text: `${L.context}${L.sep}${x.context}`, size: 18, color: "7F8C8D" })] }));
      });
    } else {
      const png = await svgToPng(renderDiagram(b.spec, b.ts, { images }));
      if (png) {
        const k = Math.min(IMG_W / png.w, IMG_MAX_H / png.h);
        children.push(new Paragraph({ alignment: AlignmentType.CENTER, children: [new ImageRun({
          type: "png", data: png.data, transformation: { width: Math.round(png.w * k), height: Math.round(png.h * k) } })] }));
      }
      children.push(small(`${b.ts} ｜ ${b.spec.title_zh || ""}${T.sep}${b.spec.concept_zh || ""}`, { italics: true }));
    }
  }
  if (lines.length) {
    children.push(heading(T.transcript));
    for (const l of lines) children.push(new Paragraph({ children: [
      new TextRun({ text: `[${l.ts}] `, size: 18, color: "7F8C8D" }), new TextRun({ text: l.text, size: 20 })] }));
  }

  const doc = new Document({
    styles: { default: { document: {
      run: { size: 22, font: { ascii: "Calibri", hAnsi: "Calibri", eastAsia: "Microsoft JhengHei" } },
      paragraph: { spacing: { after: 100, line: 312 } },
    } } },
    sections: [{
      properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 1134, bottom: 1134, left: 1134, right: 1134 } } },
      children,
    }],
  });
  return Packer.toBlob(doc);
}
