import { $, esc, hhmmss, hhmm, collapseRepeats, store, mdToHtml } from "./util.js";
import { Gemini } from "./gemini.js";
import { renderDiagram } from "./diagram.js";
import { BrowserRecognizer, GeminiAudioRecognizer } from "./recognizers.js";

const TRANSLATE_INTERVAL = 20_000;

const DEFAULTS = {
  key: "",
  engine: BrowserRecognizer.supported() ? "browser" : "gemini",
  lang: "zh-TW",
  narrInt: 180,
  diagInt: 120,
  translate: true,
  qCount: 8,
};
let cfg = { ...DEFAULTS, ...store.get("cfg", {}) };
let gemini = cfg.key ? new Gemini(cfg.key) : null;

const emptySession = () => ({
  started: null,
  lines: [],          // [{ts, text}]
  translations: [],   // [{ts, text}]
  narr: [],           // [{ts, md}]
  diagrams: [],       // [{ts, spec}]
  titles: [],
  questions: [],      // [{ts, data}]
  buf: { narr: [], diag: [], xl: [] },
});
let session = { ...emptySession(), ...store.get("session", {}) };

let rec = null, running = false, tick = null, wakeLock = null;
let lastNarr = 0, lastDiag = 0, lastXl = 0;
let narrBusy = false, diagBusy = false, questionsBusy = false;

/* ───────────── 狀態列 ───────────── */
function setStatus(msg, isError = false) {
  $("#status").textContent = msg;
  $(".statusbar").classList.toggle("error", isError);
}
const idleStatus = () => setStatus(running ? "  錄音中…" : "已停止");
function updateEngineLabel() {
  const eng = cfg.engine === "gemini" ? "Gemini 音訊辨識" : "瀏覽器即時辨識";
  $("#engine").textContent = `語音：${eng}${gemini?.lastModel ? `　｜　Gemini：${gemini.lastModel}` : ""}`;
}

let saveTimer = null;
function saveSession() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => store.set("session", session), 800);
}

/* ───────────── 畫面：逐字稿 ───────────── */
const nearBottom = (el) => el.scrollHeight - el.scrollTop - el.clientHeight < 60;

function appendLine(container, { ts, text }) {
  container.querySelector(".hint")?.remove();
  const follow = nearBottom(container);
  const p = document.createElement("p");
  p.className = "line";
  p.innerHTML = `<span class="ts">[${esc(ts)}]</span>${esc(text)}`;
  const partial = container.querySelector(".partial");
  container.insertBefore(p, partial || null);
  if (follow) container.scrollTop = container.scrollHeight;
}

function showInterim(text) {
  const box = $("#transcript");
  let el = box.querySelector(".partial");
  if (!text) { el?.remove(); return; }
  const follow = nearBottom(box);
  if (!el) {
    el = document.createElement("p");
    el.className = "line partial";
    box.appendChild(el);
  }
  el.textContent = `${text} …`;
  if (follow) box.scrollTop = box.scrollHeight;
}

function onFinal(raw) {
  const text = collapseRepeats(raw);
  const last = session.lines.at(-1)?.text;
  if (!text || text === last) return;
  const line = { ts: hhmmss(), text };
  session.lines.push(line);
  session.buf.narr.push(text);
  session.buf.diag.push(text);
  if (cfg.translate) session.buf.xl.push(text);
  appendLine($("#transcript"), line);
  saveSession();
}

/* ───────────── 翻譯 ───────────── */
async function flushTranslation() {
  if (!gemini || !cfg.translate || !session.buf.xl.length) return;
  const parts = session.buf.xl.splice(0);
  const target = cfg.lang.startsWith("zh") ? "en" : "zh";
  try {
    const out = await gemini.translate(parts.join(" "), target);
    const item = { ts: hhmmss(), text: out };
    session.translations.push(item);
    appendLine($("#translation"), item);
    updateEngineLabel();
  } catch (e) {
    session.buf.xl.unshift(...parts);        // 下次再試
    setStatus(`翻譯失敗（稍後自動重試）：${e.message.slice(0, 80)}`, true);
  }
  saveSession();
}

/* ───────────── 順稿 ───────────── */
function renderNarr({ ts, md }) {
  const box = $("#narrative");
  box.querySelectorAll(".hint").forEach((h) => h.remove());
  const follow = nearBottom(box);
  const div = document.createElement("div");
  div.innerHTML = `<div class="ts">⏱ ${esc(ts)}</div>${mdToHtml(md)}`;
  box.appendChild(div);
  if (follow) box.scrollTop = box.scrollHeight;
}

async function genNarrative(final = false) {
  if (!gemini || narrBusy) return;
  const parts = session.buf.narr.splice(0);
  const text = parts.join(" ").trim();
  if (!text || (!final && text.length < 40)) { session.buf.narr.unshift(...parts); return; }
  narrBusy = true;
  setStatus("順稿整理中…");
  try {
    const lang = detectLang(text, lectureLang());  // 順稿依這段上課內容的語言產生
    const res = await gemini.polishNarrative(text, session.titles, lang);
    const item = { ts: hhmm(), md: res.markdown, lang };
    session.titles.push(...res.titles);
    session.narr.push(item);
    renderNarr(item);
    updateEngineLabel();
    idleStatus();
  } catch (e) {
    if (running) {
      session.buf.narr.unshift(...parts);     // 放回去，下一輪與新內容一起整理
      setStatus(`順稿暫時失敗，下次自動重試：${e.message.slice(0, 80)}`, true);
    } else {
      const lang = detectLang(text, lectureLang());
      const heading = lang === "en" ? "Raw transcript (Gemini unavailable, not polished)" : "原始逐字稿（Gemini 無法連線，未整理）";
      const item = { ts: hhmm(), md: `## ${heading}\n${text}`, lang };
      session.narr.push(item);
      renderNarr(item);
      setStatus(`順稿失敗：${e.message.slice(0, 80)}`, true);
    }
  } finally {
    narrBusy = false;
    saveSession();
  }
}

/* ───────────── 課後提問 ───────────── */
// 舊資料（分成 speaker / discussion）也合併成單一清單
const questionList = (data) => data.questions || [...(data.speaker || []), ...(data.discussion || [])];

const qLabels = (lang) => lang === "en"
  ? { summary: "Key point", context: "Context", title: "Questions", sep: ": " }
  : { summary: "本堂重點", context: "對應內容", title: "課後提問", sep: "：" };

function questionsText({ ts, data, lang }) {
  const L = qLabels(lang);
  const out = [`【${L.title} ${ts}】`];
  if (data.summary) out.push(`${L.summary}${L.sep}${data.summary}`);
  if (data.summary_zh) out.push(`本堂重點：${data.summary_zh}`);
  if (data.summary) out.push("");
  questionList(data).forEach((x, i) => {
    out.push(`${i + 1}. ${x.q}`);
    if (x.q_zh) out.push(`   ${x.q_zh}`);          // 英文課：中文對照
  });
  return out.join("\n");
}

function questionsHtml({ ts, data, lang }) {
  const L = qLabels(lang);
  const items = questionList(data).map((x) => `
    <li>${esc(x.q)}${x.q_zh ? `<div class="qzh" lang="zh-Hant-TW">${esc(x.q_zh)}</div>` : ""}${x.context ? `<div class="qnote">${L.context}${L.sep}${esc(x.context)}</div>` : ""}</li>`).join("");
  return `
    <div class="qhead"><span>💬 課後提問</span><time>${esc(ts)}</time></div>
    ${data.summary ? `<p class="qsummary">${L.summary}${L.sep}${esc(data.summary)}${data.summary_zh ? `<span class="qzh" lang="zh-Hant-TW">本堂重點：${esc(data.summary_zh)}</span>` : ""}</p>` : ""}
    <ol${lang === "en" ? ' lang="en"' : ""}>${items}</ol>`;
}

function renderQuestions(item, { live = false } = {}) {
  const box = $("#narrative");
  box.querySelectorAll(".hint").forEach((h) => h.remove());
  const card = document.createElement("section");
  card.className = "questions";
  card.innerHTML = `${questionsHtml(item)}
    <div class="qactions">
      <button type="button" class="qbtn" data-act="copy">📋 複製</button>
      <button type="button" class="qbtn" data-act="regen">🔄 重新產生</button>
    </div>`;
  card.querySelector('[data-act="copy"]').addEventListener("click", async (e) => {
    try {
      await navigator.clipboard.writeText(questionsText(item));
      e.target.textContent = "✓ 已複製";
    } catch {
      e.target.textContent = "複製失敗";
    }
    setTimeout(() => (e.target.textContent = "📋 複製"), 1800);
  });
  card.querySelector('[data-act="regen"]').addEventListener("click", () => genQuestions({ replace: item, card }));
  box.appendChild(card);
  if (live) {
    showTab("narrative");
    card.scrollIntoView({ behavior: "smooth", block: "start" });
  }
  return card;
}

// 判斷文字語言：英文單字比中文字多就視為英文。
// 內容很少時：只有單一語言就直接判斷，否則用 fallback（整堂課的語言或設定）
function detectLang(text, fallback) {
  const cjk = (text.match(/[㐀-鿿]/g) || []).length;
  const words = (text.match(/[A-Za-z]+(?:['’][A-Za-z]+)?/g) || []).length;
  if (cjk + words < 20) {
    if (cjk === 0 && words >= 5) return "en";
    if (words === 0 && cjk >= 5) return "zh";
    return fallback ?? (cfg.lang.startsWith("en") ? "en" : "zh");
  }
  return words > cjk ? "en" : "zh";
}
const lectureLang = () => detectLang(session.lines.map((l) => l.text).join(" "));

function questionSource(lang) {
  // 中文課以精修順稿為主；英文課另附原始英文逐字稿，讓問題貼近原本用語
  let text = session.narr.map((n) => n.md).join("\n\n");
  const transcript = session.lines.map((l) => l.text).join(" ");
  if (lang === "en" || text.length < 300) text += "\n\n【Transcript / 逐字稿】\n" + transcript;
  return text.trim().slice(-60000);
}

async function genQuestions({ replace = null, card = null } = {}) {
  if (!gemini || questionsBusy) return;
  const lang = lectureLang();
  const source = questionSource(lang);
  if (source.length < 40) return;
  questionsBusy = true;
  setStatus("💬 產生課後提問中…");
  const placeholder = card || (() => {
    const el = document.createElement("section");
    el.className = "questions";
    $("#narrative").appendChild(el);
    return el;
  })();
  placeholder.innerHTML = `<div class="qhead"><span>💬 課後提問</span></div><p class="hint">產生中…</p>`;
  showTab("narrative");
  placeholder.scrollIntoView({ behavior: "smooth", block: "start" });
  try {
    const item = { ts: hhmm(), lang, data: await gemini.questions(source, cfg.qCount, lang) };
    if (replace) session.questions[session.questions.indexOf(replace)] = item;
    else session.questions.push(item);
    const fresh = renderQuestions(item, { live: true });
    placeholder.replaceWith(fresh);
    setStatus(running ? "  錄音中…" : "已停止 ✓ 課後提問已產生");
  } catch (e) {
    placeholder.innerHTML = `<div class="qhead"><span>💬 課後提問</span></div>
      <p class="hint">產生失敗：${esc(e.message.slice(0, 100))}</p>
      <div class="qactions"><button type="button" class="qbtn">🔄 再試一次</button></div>`;
    placeholder.querySelector("button").addEventListener("click", () => genQuestions({ replace, card: placeholder }));
    setStatus(`課後提問失敗：${e.message.slice(0, 80)}`, true);
  } finally {
    questionsBusy = false;
    saveSession();
  }
}

/* ───────────── 圖解 ───────────── */
function renderCard({ ts, spec }) {
  const box = $("#diagrams");
  box.querySelector(".hint")?.remove();
  const card = document.createElement("article");
  card.className = "card";
  const tags = (spec.key_terms || []).slice(0, 8).map((t) => `<span>#${esc(t)}</span>`).join("");
  card.innerHTML = `
    <div class="card-head"><span>${esc(spec.title_zh || "課程圖解")}</span><time>${esc(ts)}</time></div>
    ${spec.concept_zh ? `<div class="concept">${esc(spec.concept_zh)}</div>` : ""}
    ${tags ? `<div class="tags">${tags}</div>` : ""}
    <div class="svgwrap">${renderDiagram(spec, ts)}</div>`;
  box.appendChild(card);
  card.scrollIntoView({ behavior: "smooth", block: "start" });
}

async function genDiagram() {
  if (!gemini || diagBusy) return;
  const parts = session.buf.diag.splice(0);
  const text = parts.join(" ").trim();
  if (text.length < 30) { session.buf.diag.unshift(...parts); return; }
  diagBusy = true;
  setStatus("圖解生成中…");
  try {
    const spec = await gemini.diagramSpec(text);
    const item = { ts: hhmmss(), spec };
    session.diagrams.push(item);
    renderCard(item);
    idleStatus();
  } catch (e) {
    setStatus(`圖解失敗（下次再試）：${e.message.slice(0, 80)}`, true);
  } finally {
    diagBusy = false;
    saveSession();
  }
}

/* ───────────── 錄音控制 ───────────── */
async function keepAwake() {
  try { wakeLock = await navigator.wakeLock?.request("screen"); } catch { /* 不支援就算了 */ }
}

const fmt = (ms) => { const s = Math.max(0, Math.ceil(ms / 1000)); return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`; };

function onTick() {
  const now = Date.now();
  const rn = cfg.narrInt * 1000 - (now - lastNarr);
  const rd = cfg.diagInt * 1000 - (now - lastDiag);
  $("#narrTimer").textContent = `下次整理：${fmt(rn)}`;
  $("#diagTimer").textContent = `下次圖解：${fmt(rd)}`;
  $("#timers").textContent = `順稿 ${fmt(rn)}　圖解 ${fmt(rd)}`;
  if (now - lastXl >= TRANSLATE_INTERVAL) { lastXl = now; flushTranslation(); }
  if (rn <= 0) { lastNarr = now; genNarrative(); }
  if (rd <= 0) { lastDiag = now; genDiagram(); }
}

async function start() {
  if (!cfg.key) { openSettings(); return; }
  const Engine = cfg.engine === "gemini" ? GeminiAudioRecognizer : BrowserRecognizer;
  if (!Engine.supported()) {
    alert(cfg.engine === "browser"
      ? "這個瀏覽器不支援即時語音辨識（例如 Firefox）。請到設定改用「Gemini 音訊辨識」，或改用 Chrome / Edge / Safari。"
      : "這個瀏覽器無法使用麥克風。");
    return;
  }
  rec = new Engine({
    gemini, lang: cfg.lang,
    onInterim: showInterim,
    onFinal,
    onStatus: (m) => setStatus(m, !m.includes("錄音中")),
    onError: (m) => { setStatus(m, true); alert(m); stop(); },
  });
  const btn = $("#btnRec");
  btn.disabled = true;
  const ok = await rec.start();
  btn.disabled = false;
  if (ok === false) { rec = null; return; }

  running = true;
  session.started ??= Date.now();
  lastNarr = lastDiag = lastXl = Date.now();
  btn.textContent = "⏹ 停止錄音";
  btn.classList.add("on");
  setStatus("  錄音中…");
  updateEngineLabel();
  keepAwake();
  tick = setInterval(onTick, 1000);
  onTick();
  saveSession();
}

async function stop() {
  if (!running) return;
  running = false;
  clearInterval(tick);
  const btn = $("#btnRec");
  btn.textContent = "▶ 開始錄音";
  btn.classList.remove("on");
  btn.disabled = true;
  setStatus("已停止（處理最後一段語音中…）");
  try { await rec?.stop(); } catch { /* ignore */ }
  rec = null;
  btn.disabled = false;
  showInterim("");
  wakeLock?.release?.().catch(() => {});
  wakeLock = null;
  $("#narrTimer").textContent = $("#diagTimer").textContent = $("#timers").textContent = "";
  await Promise.all([flushTranslation(), genNarrative(true)]);
  if (!$(".statusbar").classList.contains("error")) setStatus("已停止");
  await genQuestions();          // 停止後依整堂內容產生課後提問
}

/* ───────────── 匯出（中文版 / English 版） ───────────── */
const EXPORT_TEXT = {
  zh: { htmlLang: "zh-Hant-TW", title: "即時課堂轉錄 順稿", exported: "匯出時間：", transcript: "原始逐字稿",
        file: "順稿_中文", locale: "zh-TW", sep: "：" },
  en: { htmlLang: "en", title: "Lecture Notes", exported: "Exported: ", transcript: "Original transcript",
        file: "LectureNotes_English", locale: "en-US", sep: ": " },
};

function hasContent() {
  return session.narr.length || session.diagrams.length || session.lines.length || session.questions.length;
}

function exportHtml() {
  if (!hasContent()) { alert("尚無內容可匯出。請先進行錄音。"); return; }
  $("#exportStatus").textContent = "";
  $("#exportDlg").showModal();
}

// 同時最多 limit 個翻譯請求，避免超過免費額度的每分鐘上限
async function mapLimit(items, limit, fn) {
  let next = 0;
  const worker = async () => { while (next < items.length) { const i = next++; await fn(items[i], i); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

// 問題卡片在匯出檔中只保留單一語言
function questionsFor(q, lang) {
  const src = q.lang || "zh";
  if (src === lang) {
    const { summary, questions, speaker, discussion } = q.data;
    return Promise.resolve({ summary, questions: questionList({ questions, speaker, discussion })
      .map(({ q: text, context }) => ({ q: text, context })) });
  }
  const key = `data_${lang}`;
  if (q[key]) return Promise.resolve(q[key]);
  if (lang === "zh" && questionList(q.data).every((x) => x.q_zh)) {
    // 英文課已有中文對照：直接使用，只需翻譯「對應內容」；無法翻譯時就省略對應內容
    const zh = { summary: q.data.summary_zh || q.data.summary,
                 questions: questionList(q.data).map((x) => ({ q: x.q_zh, context: x.context || "" })) };
    const noContext = { ...zh, questions: zh.questions.map(({ q: text }) => ({ q: text })) };
    if (!gemini) return Promise.resolve(noContext);
    return gemini.translateJson(zh, "zh").then((d) => (q[key] = d)).catch(() => noContext);
  }
  const plain = { summary: q.data.summary, questions: questionList(q.data).map((x) => ({ q: x.q, context: x.context || "" })) };
  return gemini.translateJson(plain, lang).then((d) => (q[key] = d));
}

async function buildExport(lang, progress) {
  const T = EXPORT_TEXT[lang];
  const narrSrc = session.narr;
  const mdKey = `md_${lang}`;
  // 順稿依上課語言產生（舊資料沒有 lang 視為中文）；語言不同時才翻譯
  const narrMd = (n) => ((n.lang || "zh") === lang ? n.md : n[mdKey]);
  const jobs = [];
  narrSrc.forEach((n) => {
    if (!narrMd(n)) jobs.push(async () => { n[mdKey] = await gemini.translateMarkdown(n.md, lang); });
  });
  if (lang === "en") {
    session.diagrams.forEach((d) => { if (!d.spec_en) jobs.push(async () => { d.spec_en = await gemini.translateJson(d.spec, "en"); }); });
  }
  if (jobs.length && !gemini) throw new Error("需要翻譯，請先在設定中輸入 Gemini API Key");
  session.questions.forEach((q) => {
    if ((q.lang || "zh") !== lang && !q[`data_${lang}`]) jobs.push(() => questionsFor(q, lang));
  });
  let done = 0;
  progress(jobs.length ? `翻譯中… 0 / ${jobs.length}` : "");
  await mapLimit(jobs, 3, async (job) => { await job(); progress(`翻譯中… ${++done} / ${jobs.length}`); });
  saveSession();

  const qBlocks = await Promise.all(session.questions.map(async (q) => ({
    ts: q.ts + "~",
    html: `<section class="questions">${questionsHtml({ ts: q.ts, lang, data: await questionsFor(q, lang) })}</section>`,
  })));
  const blocks = [
    ...narrSrc.map((n) => ({ ts: n.ts, html: `<div class="ts">⏱ ${esc(n.ts)}</div>${mdToHtml(narrMd(n))}` })),
    ...qBlocks,
    ...session.diagrams.map((d) => {
      const spec = lang === "en" ? d.spec_en : d.spec;
      return { ts: d.ts, html: `<figure>${renderDiagram(spec, d.ts)}<figcaption>${esc(d.ts)} ｜ ${esc(spec.title_zh || "")}${T.sep}${esc(spec.concept_zh || "")}</figcaption></figure>` };
    }),
  ].sort((a, b) => a.ts.localeCompare(b.ts));

  const started = session.started ? new Date(session.started) : new Date();
  const label = `${started.toLocaleDateString(T.locale)} ${hhmm(started)}`;
  const transcript = session.lines.map((l) => `<p><span class="ts">[${esc(l.ts)}]</span> ${esc(l.text)}</p>`).join("\n");
  return `<!doctype html>
<html lang="${T.htmlLang}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${T.title} ${esc(label)}</title>
<style>
 body{font-family:${lang === "en" ? `Georgia,"Segoe UI",` : ""}"Microsoft JhengHei","PingFang TC","Noto Sans TC",sans-serif;max-width:860px;margin:40px auto;padding:0 20px;color:#2c3e50;background:#fdfcf7;line-height:1.85}
 h1{color:#1a252f;border-bottom:3px solid #2980b9;padding-bottom:8px}
 h2{color:#1f4e79;margin-top:32px;padding:6px 12px;background:#dceaf6;border-left:5px solid #2980b9}
 p{margin:8px 0} blockquote{border-left:4px solid #f39c12;background:#fdf6e3;color:#7d6608;padding:8px 14px;margin:10px 0}
 code{background:#f4ecf7;color:#6a1b9a;padding:1px 6px;border-radius:3px;font-family:Consolas,monospace}
 .term{color:#0b5394} .ts{color:#7f8c8d;font-size:.85em;margin-top:20px}
 figure{margin:24px 0} figure svg{width:100%;height:auto;border:1px solid #dde1e7;border-radius:6px}
 figcaption{color:#7f8c8d;font-size:.9em;margin-top:6px;text-align:center}
 details{margin-top:40px} summary{cursor:pointer;color:#2980b9;font-weight:700}
 .questions{margin:28px 0;border:1px solid #d6c7ec;border-radius:8px;background:#faf7ff;padding:4px 18px 12px}
 .qhead{display:flex;justify-content:space-between;font-weight:700;color:#5b2c8f;font-size:1.15em;padding:8px 0}
 .qhead time{font-weight:400;color:#7f8c8d;font-size:.8em}
 .questions li{margin:6px 0} .qnote{color:#7f8c8d;font-size:.88em} .qsummary{font-weight:700}
</style></head><body>
<h1>${T.title} ${esc(label)}</h1>
<div class="ts">${T.exported}${esc(new Date().toLocaleString(T.locale))}</div>
${blocks.map((b) => b.html).join("\n")}
${transcript ? `<details><summary>${T.transcript}</summary>${transcript}</details>` : ""}
</body></html>`;
}

function download(doc, name) {
  const url = URL.createObjectURL(new Blob([doc], { type: "text/html;charset=utf-8" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

async function doExport(lang) {
  const status = $("#exportStatus");
  const buttons = document.querySelectorAll("#exportDlg [data-lang]");
  if (lang === "en" && !gemini) { status.textContent = "English 版需要翻譯，請先在設定中輸入 Gemini API Key。"; return; }
  buttons.forEach((b) => (b.disabled = true));
  try {
    const doc = await buildExport(lang, (m) => (status.textContent = m));
    const d = new Date();
    const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}_${hhmmss(d).replace(/:/g, "")}`;
    download(doc, `${EXPORT_TEXT[lang].file}_${stamp}.html`);
    status.textContent = lang === "en" ? "✓ English 版已下載" : "✓ 中文版已下載";
  } catch (e) {
    status.textContent = `匯出失敗：${e.message.slice(0, 100)}`;
  } finally {
    buttons.forEach((b) => (b.disabled = false));
  }
}

/* ───────────── 設定 ───────────── */
function openSettings() {
  $("#setKey").value = cfg.key;
  $("#setEngine").value = cfg.engine;
  $("#setLang").value = cfg.lang;
  $("#setNarr").value = cfg.narrInt;
  $("#setDiag").value = cfg.diagInt;
  $("#setQCount").value = cfg.qCount;
  $("#engineNote").textContent = BrowserRecognizer.supported()
    ? "iPhone / iPad：請用 Safari，並開啟「設定 › 一般 › 鍵盤 › 聽寫」。若常中斷，改用 Gemini 音訊辨識。"
    : "⚠ 這個瀏覽器不支援即時辨識，請使用「Gemini 音訊辨識」。";
  $("#settings").showModal();
}

function applySettings() {
  const next = {
    ...cfg,
    key: $("#setKey").value.trim(),
    engine: $("#setEngine").value,
    lang: $("#setLang").value,
    narrInt: Math.max(60, parseInt($("#setNarr").value, 10) || DEFAULTS.narrInt),
    diagInt: Math.max(60, parseInt($("#setDiag").value, 10) || DEFAULTS.diagInt),
    qCount: Math.min(20, Math.max(1, parseInt($("#setQCount").value, 10) || DEFAULTS.qCount)),
  };
  const restart = running && (next.engine !== cfg.engine || next.lang !== cfg.lang || next.key !== cfg.key);
  if (next.key !== cfg.key) gemini = next.key ? new Gemini(next.key) : null;
  cfg = next;
  store.set("cfg", cfg);
  applyTranslateUi();
  updateEngineLabel();
  if (restart) stop().then(start);
}

function applyTranslateUi() {
  $("#chkTranslate").checked = cfg.translate;
  $("#translateBox").hidden = !cfg.translate;
  $("#translateHead").textContent = cfg.lang.startsWith("zh") ? "📄 English Translation" : "📄 中文翻譯";
}

/* ───────────── 初始化 ───────────── */
function showTab(tab) {
  document.querySelectorAll(".tabs button").forEach((x) => x.classList.toggle("active", x.dataset.tab === tab));
  document.querySelectorAll(".pane").forEach((p) => p.classList.toggle("active", p.id === `pane-${tab}`));
}

function restoreSession() {
  session.questions ??= [];
  session.lines.forEach((l) => appendLine($("#transcript"), l));
  session.translations.forEach((t) => appendLine($("#translation"), t));
  [...session.narr.map((n) => ({ ts: n.ts, draw: () => renderNarr(n) })),
   ...session.questions.map((q) => ({ ts: q.ts + "~", draw: () => renderQuestions(q) }))]   // 同一分鐘時提問排在順稿之後
    .sort((a, b) => a.ts.localeCompare(b.ts))
    .forEach((x) => x.draw());
  session.diagrams.forEach((d) => {
    try { renderCard(d); } catch (e) { console.warn(e); }
  });
  $("#diagrams").scrollTop = $("#diagrams").scrollHeight;
}

function bind() {
  $("#btnRec").addEventListener("click", () => (running ? stop() : start()));
  $("#btnSettings").addEventListener("click", openSettings);
  $("#btnExport").addEventListener("click", exportHtml);
  document.querySelectorAll("#exportDlg [data-lang]").forEach((b) =>
    b.addEventListener("click", () => doExport(b.dataset.lang)));
  $("#btnExportClose").addEventListener("click", () => $("#exportDlg").close());
  $("#btnNew").addEventListener("click", async () => {
    if (!confirm("清除目前的逐字稿、順稿與圖解，開始新課程？（建議先匯出 HTML）")) return;
    if (running) await stop();
    session = emptySession();
    store.set("session", session);
    location.reload();
  });
  $("#chkTranslate").addEventListener("change", (e) => {
    cfg.translate = e.target.checked;
    store.set("cfg", cfg);
    applyTranslateUi();
  });
  $("#btnShowKey").addEventListener("click", () => {
    const k = $("#setKey");
    k.type = k.type === "password" ? "text" : "password";
  });
  // 直接處理送出（按「儲存」或在欄位中按 Enter），不依賴 dialog 的 close 事件
  $("#settingsForm").addEventListener("submit", (e) => {
    e.preventDefault();
    applySettings();
    $("#settings").close();
  });
  $("#btnCancel").addEventListener("click", () => $("#settings").close());
  document.querySelectorAll(".tabs button").forEach((b) =>
    b.addEventListener("click", () => showTab(b.dataset.tab)));
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && running) {
      keepAwake();
      rec?.ctx?.resume?.();
    } else if (running) {
      setStatus("⚠ 畫面離開或鎖定時，手機會暫停收音，請保持此頁在前景", true);
    }
  });
  window.addEventListener("beforeunload", (e) => {
    store.set("session", session);
    if (running) { e.preventDefault(); e.returnValue = ""; }
  });
}

bind();
applyTranslateUi();
showTab("transcript");
restoreSession();
updateEngineLabel();
setStatus(cfg.key ? "就緒 ✓  按「開始錄音」開始" : "請先在設定中輸入 Gemini API Key");
if (!cfg.key) openSettings();

if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}

// 測試用：網址加上 ?debug 可從主控台注入文字
if (new URLSearchParams(location.search).has("debug")) {
  window.lecture = { onFinal, genNarrative, genDiagram, genQuestions, flushTranslation, session: () => session };
}
