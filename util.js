export const $ = (sel, root = document) => root.querySelector(sel);

export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export const hhmmss = (d = new Date()) => d.toTimeString().slice(0, 8);
export const hhmm = (d = new Date()) => d.toTimeString().slice(0, 5);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 語音辨識偶爾會陷入「同一句一直重複」的迴圈；連續重複 3 次以上的片段只保留一次
const REPEAT_RE = /(.{2,40}?)(?:[\s，。,.、！？!?]*\1){2,}/gs;
export function collapseRepeats(text) {
  let prev, t = String(text ?? "");
  do { prev = t; t = t.replace(REPEAT_RE, "$1"); } while (t !== prev);
  return t.trim();
}

export const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v == null ? fallback : JSON.parse(v);
    } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* 私密模式或容量已滿 */ }
  },
};

// 輕量 markdown → HTML（僅支援順稿用到的語法），輸入一律先跳脫
function inline(t) {
  t = esc(t);
  t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  t = t.replace(/`([^`]+)`/g, "<code>$1</code>");
  t = t.replace(/([一-鿿]{1,12})\s*[（(]\s*([A-Za-z0-9 ,./\-+_’']+)\s*[)）]/g,
    "<span class='term'>$1（$2）</span>");
  return t;
}

export function mdToHtml(md) {
  const out = [];
  let list = null;
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (const raw of String(md).split("\n")) {
    const s = raw.trimEnd();
    if (!s.trim()) { closeList(); continue; }
    let m;
    if ((m = s.match(/^#{1,6}\s+(.+)$/))) { closeList(); out.push(`<h2>${inline(m[1])}</h2>`); continue; }
    if (s.trimStart().startsWith(">")) { closeList(); out.push(`<blockquote>${inline(s.trimStart().slice(1).trim())}</blockquote>`); continue; }
    if ((m = s.match(/^\s*[-•*]\s+(.+)$/))) {
      if (list !== "ul") { closeList(); out.push("<ul>"); list = "ul"; }
      out.push(`<li>${inline(m[1])}</li>`); continue;
    }
    if ((m = s.match(/^\s*\d+[.、)]\s+(.+)$/))) {
      if (list !== "ol") { closeList(); out.push("<ol>"); list = "ol"; }
      out.push(`<li>${inline(m[1])}</li>`); continue;
    }
    closeList();
    out.push(`<p>${inline(s)}</p>`);
  }
  closeList();
  return out.join("\n");
}
