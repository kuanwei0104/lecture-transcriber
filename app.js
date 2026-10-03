import { $, esc, hhmmss, hhmm, collapseRepeats, store, mdToHtml } from "./util.js";
import { Gemini } from "./gemini.js";
import { renderDiagram, renderMindmap } from "./diagram.js";
import { BrowserRecognizer, GeminiAudioRecognizer } from "./recognizers.js";
import { audioStore, ClipRecorder, ClipPlayer } from "./audio.js";
import { cloud } from "./cloud.js";

const TRANSLATE_INTERVAL = 20_000;

const DEFAULTS = {
  key: "",
  engine: BrowserRecognizer.supported() ? "browser" : "gemini",
  lang: "zh-TW",
  narrInt: 180,
  diagInt: 120,
  translate: true,
  qCount: 8,
  recordAudio: true,
};
let cfg = { ...DEFAULTS, ...store.get("cfg", {}) };
// 課程講義（可選）：{names, outline, terms}
let handout = store.get("handout", { names: [], outline: "", terms: [] });
let gemini = null;
function refreshGemini() {
  gemini = cfg.key ? new Gemini(cfg.key)
         : cloud.user ? new Gemini("", { proxy: cloud.aiProxy })
         : null;
}
refreshGemini();

const newId = () => (crypto.randomUUID ? crypto.randomUUID() : `s${Date.now()}${Math.random().toString(16).slice(2)}`);
const emptySession = () => ({
  id: newId(),
  started: null,
  audio: [],          // [{key, startedAt, duration, mime}] 每次開始～停止錄音一段
  lines: [],          // [{ts, text}]
  translations: [],   // [{ts, text}]
  narr: [],           // [{ts, md}]
  diagrams: [],       // [{ts, spec}]
  titles: [],
  questions: [],      // [{ts, data}]
  buf: { narr: [], diag: [], xl: [] },
});
let session = { ...emptySession(), ...store.get("session", {}) };
session.id ??= newId();
session.audio ??= [];

let rec = null, running = false, tick = null, wakeLock = null;
let lastNarr = 0, lastDiag = 0, lastXl = 0;
let narrBusy = false, diagBusy = false, questionsBusy = false;
let recorder = null, recSeg = null, utterStart = null;   // 音檔錄製與時間對齊

/* ───────────── 狀態列 ───────────── */
function setStatus(msg, isError = false) {
  $("#status").textContent = msg;
  $(".statusbar").classList.toggle("error", isError);
}
const idleStatus = () => setStatus(running ? "  錄音中…" : "已停止");
function updateEngineLabel() {
  const eng = cfg.engine === "gemini" ? "Gemini 音訊辨識" : "瀏覽器即時辨識";
  const via = gemini?.proxy ? "雲端 AI" : "Gemini";
  $("#engine").textContent = `語音：${eng}${gemini?.lastModel ? `　｜　${via}：${gemini.lastModel}` : ""}`;
}

let saveTimer = null;
function saveSession() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => store.set("session", session), 800);
  scheduleCloudSync();
}

/* ───────────── 畫面：逐字稿 ───────────── */
const nearBottom = (el) => el.scrollHeight - el.scrollTop - el.clientHeight < 60;

function appendLine(container, { ts, text, seg = null, t = null }) {
  container.querySelector(".hint")?.remove();
  const follow = nearBottom(container);
  const p = document.createElement("p");
  p.className = "line";
  p.innerHTML = `<span class="ts">[${esc(ts)}]</span>${esc(text)}`;
  if (seg != null && t != null) {           // 有音檔的句子：點一下從那裡開始播放
    p.classList.add("seekable");
    p.dataset.seg = seg;
    p.dataset.t = t;
    p.title = "點一下從這句開始播放";
  }
  const partial = container.querySelector(".partial");
  container.insertBefore(p, partial || null);
  if (follow) container.scrollTop = container.scrollHeight;
}

function showInterim(text) {
  const box = $("#transcript");
  let el = box.querySelector(".partial");
  if (!text) { el?.remove(); return; }
  if (running && utterStart == null) utterStart = Date.now();
  const follow = nearBottom(box);
  if (!el) {
    el = document.createElement("p");
    el.className = "line partial";
    box.appendChild(el);
  }
  el.textContent = `${text} …`;
  if (follow) box.scrollTop = box.scrollHeight;
}

function onFinal(raw, startedAt) {
  const text = collapseRepeats(raw);
  const last = session.lines.at(-1)?.text;
  const began = startedAt ?? utterStart ?? Date.now() - 2500;
  utterStart = null;
  if (!text || text === last) return;
  const line = { ts: hhmmss(), text };
  if (recSeg != null) {                     // 對齊音檔：這句話在本段錄音的第幾秒開始
    line.seg = recSeg;
    line.t = Math.max(0, Math.round((began - session.audio[recSeg].startedAt - 300) / 100) / 10);
  }
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
    setStatus(`翻譯失敗（稍後自動重試）：${friendlyError(e)}`, true);
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
    const res = await gemini.polishNarrative(text, session.titles, lang, handout.outline);
    const item = { ts: hhmm(), md: res.markdown, lang };
    session.titles.push(...res.titles);
    session.narr.push(item);
    renderNarr(item);
    updateEngineLabel();
    idleStatus();
  } catch (e) {
    if (running) {
      session.buf.narr.unshift(...parts);     // 放回去，下一輪與新內容一起整理
      setStatus(`順稿暫時失敗，下次自動重試：${friendlyError(e)}`, true);
    } else {
      const lang = detectLang(text, lectureLang());
      const heading = lang === "en" ? "Raw transcript (Gemini unavailable, not polished)" : "原始逐字稿（Gemini 無法連線，未整理）";
      const item = { ts: hhmm(), md: `## ${heading}\n${text}`, lang };
      session.narr.push(item);
      renderNarr(item);
      setStatus(`順稿失敗：${friendlyError(e)}`, true);
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
  if (!gemini || questionsBusy || cfg.qCount <= 0) return;   // 題數設為 0 就不產生
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
    const item = { ts: hhmm(), lang, data: await gemini.questions(source, cfg.qCount, lang, handout.outline) };
    if (replace) session.questions[session.questions.indexOf(replace)] = item;
    else session.questions.push(item);
    const fresh = renderQuestions(item, { live: true });
    placeholder.replaceWith(fresh);
    setStatus(running ? "  錄音中…" : "已停止 ✓ 課後提問已產生");
  } catch (e) {
    placeholder.innerHTML = `<div class="qhead"><span>💬 課後提問</span></div>
      <p class="hint">產生失敗：${esc(friendlyError(e))}</p>
      <div class="qactions"><button type="button" class="qbtn">🔄 再試一次</button></div>`;
    placeholder.querySelector("button").addEventListener("click", () => genQuestions({ replace, card: placeholder }));
    setStatus(`課後提問失敗：${friendlyError(e)}`, true);
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
    const spec = await gemini.diagramSpec(text, handout.outline);
    const item = { ts: hhmmss(), spec };
    session.diagrams.push(item);
    renderCard(item);
    idleStatus();
  } catch (e) {
    setStatus(`圖解失敗（下次再試）：${friendlyError(e)}`, true);
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

/* ───────────── 音檔錄製與同步播放 ───────────── */
async function startRecorder() {
  recSeg = null;
  if (!cfg.recordAudio || !ClipRecorder.supported()) return;
  try {
    recorder = new ClipRecorder();
    const startedAt = await recorder.start(rec?.stream);
    session.audio.push({ key: `${session.id}:${session.audio.length}`, startedAt, duration: 0, mime: "" });
    recSeg = session.audio.length - 1;
  } catch (e) {
    recorder = null;
    setStatus(`無法同時錄下音檔（逐字稿照常進行）：${e.message.slice(0, 60)}`, true);
  }
}

async function stopRecorder() {
  if (!recorder || recSeg == null) { recorder = null; recSeg = null; return; }
  const seg = session.audio[recSeg];
  const blob = await recorder.stop();
  recorder = null;
  if (blob && blob.size) {
    seg.duration = (Date.now() - seg.startedAt) / 1000;
    seg.mime = blob.type;
    try { await audioStore.put(seg.key, blob); } catch (e) { setStatus(`音檔儲存失敗：${e.message.slice(0, 60)}`, true); }
    uploadSegAudio(seg, blob);
  }
  recSeg = null;
  saveSession();
  showPlayer();
}

const fmtTime = (s) => {
  s = Math.max(0, Math.floor(s || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return (h ? `${h}:${String(m).padStart(2, "0")}` : `${m}`) + `:${String(sec).padStart(2, "0")}`;
};

const player = new ClipPlayer({
  onTime(seg, t) {
    if (seg == null) return;
    const dur = session.audio[seg]?.duration || 0;
    $("#pTime").textContent = `${fmtTime(t)} / ${fmtTime(dur)}`;
    if (!seeking) { $("#pSeek").max = dur || 1; $("#pSeek").value = t; }
    // 標示目前播放到的句子
    let now = null;
    document.querySelectorAll(`#transcript .seekable[data-seg="${seg}"]`).forEach((el) => {
      if (Number(el.dataset.t) <= t + 0.2) now = el;
    });
    document.querySelectorAll("#transcript .line.now").forEach((el) => el !== now && el.classList.remove("now"));
    if (now && !now.classList.contains("now")) {
      now.classList.add("now");
      if (!player.audio.paused) now.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  },
  onState(playing) { $("#btnPlay").textContent = playing ? "⏸" : "▶"; },
});
let seeking = false;

function showPlayer() {
  const has = session.audio.some((a) => a.duration > 0);
  $("#player").hidden = !has;
  if (has && player.seg == null) {
    const last = session.audio.length - 1;
    $("#pTime").textContent = `0:00 / ${fmtTime(session.audio[last].duration)}`;
  }
}

async function playFrom(seg, t) {
  if (running) { setStatus("錄音中無法播放，請先停止錄音", true); return; }
  const info = session.audio[seg];
  if (!info || !info.duration) { setStatus("這段沒有錄下音檔", true); return; }
  if (!(await audioStore.get(info.key).catch(() => null)) && info.cloud && cloud.user) {
    setStatus("從雲端下載音檔中…");
    try { await audioStore.put(info.key, await cloud.downloadAudio(info.cloud)); idleStatus(); }
    catch (e) { setStatus(`音檔下載失敗：${e.message.slice(0, 60)}`, true); return; }
  }
  if (!(await player.load(seg, info.key))) { setStatus("找不到這段音檔（可能已被瀏覽器清除）", true); return; }
  await player.playAt(Math.max(0, t - 0.5));
}

function bindPlayer() {
  $("#transcript").addEventListener("click", (e) => {
    const line = e.target.closest(".seekable");
    if (line) playFrom(Number(line.dataset.seg), Number(line.dataset.t));
  });
  $("#btnPlay").addEventListener("click", async () => {
    if (player.seg == null) {
      const seg = session.audio.findLastIndex((a) => a.duration > 0);
      if (seg >= 0) await playFrom(seg, 0);
    } else player.toggle();
  });
  const seek = $("#pSeek");
  seek.addEventListener("input", () => { seeking = true; $("#pTime").textContent = `${fmtTime(seek.value)} / ${fmtTime(seek.max)}`; });
  seek.addEventListener("change", () => { seeking = false; if (player.seg != null) player.seek(Number(seek.value)); });
  $("#pRate").addEventListener("change", (e) => { player.rate = Number(e.target.value); });
}

async function start() {
  if (!gemini) { cloud.enabled ? openAccount() : openSettings(); return; }
  const Engine = cfg.engine === "gemini" ? GeminiAudioRecognizer : BrowserRecognizer;
  if (!Engine.supported()) {
    alert(cfg.engine === "browser"
      ? "這個瀏覽器不支援即時語音辨識（例如 Firefox）。請到設定改用「Gemini 音訊辨識」，或改用 Chrome / Edge / Safari。"
      : "這個瀏覽器無法使用麥克風。");
    return;
  }
  rec = new Engine({
    gemini, lang: cfg.lang, terms: handout.terms.join("、").slice(0, 400),
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
  player.pause();
  await startRecorder();
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
  await stopRecorder();
  btn.disabled = false;
  showInterim("");
  wakeLock?.release?.().catch(() => {});
  wakeLock = null;
  $("#narrTimer").textContent = $("#diagTimer").textContent = $("#timers").textContent = "";
  await Promise.all([flushTranslation(), genNarrative(true)]);
  if (!$(".statusbar").classList.contains("error")) setStatus("已停止");
  await genQuestions();          // 停止後依整堂內容產生課後提問
}

// 把 API 錯誤翻成看得懂的說明
function friendlyError(e) {
  const msg = String(e?.message || e);
  if (/429|RESOURCE_EXHAUSTED|quota/i.test(msg)) return "Gemini 免費額度已用完（每日配額），請稍後或明天再試";
  if (/503|UNAVAILABLE/i.test(msg)) return "Gemini 伺服器忙碌中，請稍後再試";
  if (/API key|401|403/i.test(msg)) return "Gemini API Key 無效或沒有權限，請到設定確認";
  return msg.slice(0, 120);
}

/* ───────────── 匯出（中文版 / English 版） ───────────── */
const EXPORT_TEXT = {
  zh: { htmlLang: "zh-Hant-TW", title: "即時課堂轉錄 順稿", exported: "匯出時間：", transcript: "原始逐字稿",
        mindmap: "課程心智圖", file: "順稿_中文", locale: "zh-TW", sep: "：" },
  en: { htmlLang: "en", title: "Lecture Notes", exported: "Exported: ", transcript: "Original transcript",
        mindmap: "Mind map", file: "LectureNotes_English", locale: "en-US", sep: ": " },
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
  const failures = [];
  const soft = (fn) => async () => {        // 失敗不中斷匯出：改用原文並記錄原因
    try { await fn(); } catch (e) { console.warn("[Export]", e); failures.push(friendlyError(e)); }
  };
  narrSrc.forEach((n) => {
    if (narrMd(n)) return;
    if (gemini) jobs.push(soft(async () => { n[mdKey] = await gemini.translateMarkdown(n.md, lang); }));
    else failures.push("尚未設定 Gemini API Key");
  });
  if (lang === "en" && gemini) {
    session.diagrams.forEach((d) => { if (!d.spec_en) jobs.push(soft(async () => { d.spec_en = await gemini.translateJson(d.spec, "en"); })); });
  }
  session.questions.forEach((q) => {
    if ((q.lang || "zh") !== lang && !q[`data_${lang}`]) jobs.push(soft(() => questionsFor(q, lang)));
  });
  // 整堂課的心智圖（內容有變才重新產生）
  session.mindmaps ??= {};
  const stamp = `${session.narr.length}:${session.lines.length}`;
  if (gemini && session.mindmaps[lang]?.stamp !== stamp) {
    jobs.push(async () => {
      try {
        session.mindmaps[lang] = { stamp, tree: await gemini.mindmap(questionSource(lang), lang, handout.outline) };
      } catch (e) {
        console.warn("[Mindmap]", e.message);       // 失敗就略過心智圖，不影響其他內容
        failures.push(friendlyError(e));
      }
    });
  }
  let done = 0;
  progress(jobs.length ? `整理中… 0 / ${jobs.length}` : "");
  await mapLimit(jobs, 3, async (job) => { await job(); progress(`整理中… ${++done} / ${jobs.length}`); });
  saveSession();

  const qBlocks = await Promise.all(session.questions.map(async (q) => ({
    ts: q.ts + "~",
    html: `<section class="questions">${questionsHtml({ ts: q.ts, lang, data: await questionsFor(q, lang) })}</section>`,
  })));
  const blocks = [
    ...narrSrc.map((n) => ({ ts: n.ts, html: `<div class="ts">⏱ ${esc(n.ts)}</div>${mdToHtml(narrMd(n) || n.md)}` })),
    ...qBlocks,
    ...session.diagrams.map((d) => {
      const spec = (lang === "en" ? d.spec_en : d.spec) || d.spec;
      return { ts: d.ts, html: `<figure>${renderDiagram(spec, d.ts)}<figcaption>${esc(d.ts)} ｜ ${esc(spec.title_zh || "")}${T.sep}${esc(spec.concept_zh || "")}</figcaption></figure>` };
    }),
  ].sort((a, b) => a.ts.localeCompare(b.ts));

  const warning = failures.length
    ? (lang === "en" ? `Some sections could not be translated (${failures[0]}), so the original text is kept.`
                     : `部分內容未翻譯（${failures[0]}），該段落保留原文。`)
    : "";
  const tree = session.mindmaps?.[lang]?.tree;
  const mindmapHtml = tree
    ? `<figure class="mindmap"><h2>${T.mindmap}</h2>${renderMindmap(tree)}</figure>`
    : "";
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
 .mindmap{margin:24px 0 36px} .mindmap h2{margin-bottom:10px}
 .warn{background:#fdf6e3;border-left:4px solid #f39c12;color:#7d6608;padding:8px 14px;margin:16px 0}
 figcaption{color:#7f8c8d;font-size:.9em;margin-top:6px;text-align:center}
 details{margin-top:40px} summary{cursor:pointer;color:#2980b9;font-weight:700}
 .questions{margin:28px 0;border:1px solid #d6c7ec;border-radius:8px;background:#faf7ff;padding:4px 18px 12px}
 .qhead{display:flex;justify-content:space-between;font-weight:700;color:#5b2c8f;font-size:1.15em;padding:8px 0}
 .qhead time{font-weight:400;color:#7f8c8d;font-size:.8em}
 .questions li{margin:6px 0} .qnote{color:#7f8c8d;font-size:.88em} .qsummary{font-weight:700}
</style></head><body>
<h1>${T.title} ${esc(label)}</h1>
<div class="ts">${T.exported}${esc(new Date().toLocaleString(T.locale))}</div>
${warning ? `<div class="warn">⚠ ${esc(warning)}</div>` : ""}
${mindmapHtml}
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

// 匯出檔名：日期_當次課程主題_中文 / 日期_當次課程主題_English
function lectureTopic(lang) {
  const root = session.mindmaps?.[lang]?.tree?.root;
  if (root) return String(root);
  for (const n of session.narr) {
    const md = (n.lang || "zh") === lang ? n.md : n[`md_${lang}`];
    const m = md && md.match(/^##\s+(.+)$/m);
    if (m && !/原始逐字稿|Raw transcript/.test(m[1])) return m[1];
  }
  return lang === "en" ? "Lecture Notes" : "課堂筆記";
}

function exportFileName(lang) {
  const d = session.started ? new Date(session.started) : new Date();
  const date = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  const topic = lectureTopic(lang)
    .replace(/[\\/:*?"<>|\r\n\t]+/g, " ")      // Windows／macOS 不允許的字元
    .replace(/\s+/g, " ").trim().slice(0, 40) || (lang === "en" ? "Lecture Notes" : "課堂筆記");
  return `${date}_${topic}_${lang === "en" ? "English" : "中文"}.html`;
}

async function doExport(lang) {
  const status = $("#exportStatus");
  const buttons = document.querySelectorAll("#exportDlg [data-lang]");
  if (lang === "en" && !gemini) { status.textContent = "English 版需要翻譯，請先在設定中輸入 Gemini API Key。"; return; }
  buttons.forEach((b) => (b.disabled = true));
  try {
    const doc = await buildExport(lang, (m) => (status.textContent = m));
    download(doc, exportFileName(lang));
    status.textContent = lang === "en" ? "✓ English 版已下載" : "✓ 中文版已下載";
  } catch (e) {
    status.textContent = `匯出失敗：${friendlyError(e)}`;
  } finally {
    buttons.forEach((b) => (b.disabled = false));
  }
}


/* ───────────── 課程講義（可選） ───────────── */
const fileToBase64 = (file) => new Promise((res, rej) => {
  const r = new FileReader();
  r.onload = () => res(String(r.result).split(",")[1]);
  r.onerror = rej;
  r.readAsDataURL(file);
});

function renderHandout() {
  const box = $("#handoutInfo");
  box.textContent = handout.names.length
    ? `已載入：${handout.names.join("、")}（術語 ${handout.terms.length} 個）`
    : "尚未載入（沒有講義也能正常使用）";
  $("#btnClearHandout").hidden = !handout.names.length;
}

async function loadHandout(files) {
  if (!files.length) return;
  if (!gemini) { $("#handoutInfo").textContent = "請先填入 Gemini API Key 再載入講義"; return; }
  const names = [...handout.names];
  let outline = handout.outline, terms = [...handout.terms];
  for (const [i, f] of [...files].entries()) {
    $("#handoutInfo").textContent = `讀取講義 ${i + 1}/${files.length}：${f.name} …`;
    try {
      if (f.size > 15 * 1024 * 1024) throw new Error("檔案超過 15MB");
      const isPdf = /\.pdf$/i.test(f.name) || f.type === "application/pdf";
      const digest = isPdf
        ? await gemini.handoutDigest({ pdfBase64: await fileToBase64(f), name: f.name })
        : await gemini.handoutDigest({ text: await f.text(), name: f.name });
      outline = (outline ? outline + "\n" : "") + digest.outline;
      terms = [...new Set([...terms, ...digest.terms])].slice(0, 40);
      names.push(f.name);
    } catch (e) {
      $("#handoutInfo").textContent = `${f.name} 讀取失敗：${friendlyError(e)}`;
      return;
    }
  }
  handout = { names, outline: outline.slice(0, 6000), terms };
  store.set("handout", handout);
  renderHandout();
}

/* ───────────── 設定 ───────────── */
function openSettings() {
  $("#setKey").value = cfg.key;
  $("#setEngine").value = cfg.engine;
  $("#setLang").value = cfg.lang;
  $("#setNarr").value = cfg.narrInt;
  $("#setDiag").value = cfg.diagInt;
  $("#setQCount").value = cfg.qCount;
  $("#setRecordAudio").checked = cfg.recordAudio;
  renderHandout();
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
    qCount: Math.min(20, Math.max(0, parseInt($("#setQCount").value, 10) || 0)),
    recordAudio: $("#setRecordAudio").checked,
  };
  const restart = running && (next.engine !== cfg.engine || next.lang !== cfg.lang || next.key !== cfg.key);
  cfg = next;
  refreshGemini();
  store.set("cfg", cfg);
  applyTranslateUi();
  updateEngineLabel();
  if (restart) stop().then(start);
}

// 拖曳分隔線調整逐字稿與翻譯的高度
function bindSplitter() {
  const bar = $("#splitter"), box = $("#translateBox"), pane = $("#pane-transcript");
  const saved = store.get("translateH", null);
  if (saved) box.style.flexBasis = `${saved}px`;
  let startY = 0, startH = 0;
  const move = (e) => {
    const y = e.touches ? e.touches[0].clientY : e.clientY;
    const max = pane.clientHeight - 120;
    const h = Math.max(60, Math.min(max, startH + (startY - y)));
    box.style.flexBasis = `${h}px`;
  };
  const end = () => {
    document.removeEventListener("pointermove", move);
    document.removeEventListener("pointerup", end);
    store.set("translateH", box.getBoundingClientRect().height);
  };
  bar.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    startY = e.clientY;
    startH = box.getBoundingClientRect().height;
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", end);
  });
}

function applyTranslateUi() {
  $("#chkTranslate").checked = cfg.translate;
  $("#translateBox").hidden = !cfg.translate;
  $("#splitter").hidden = !cfg.translate;
  $("#translateHead").textContent = cfg.lang.startsWith("zh") ? "📄 English Translation" : "📄 中文翻譯";
}

/* ───────────── 帳號與雲端同步（Supabase，可選） ───────────── */
let syncTimer = null;

function scheduleCloudSync() {
  if (!cloud.user) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(syncNow, 4000);
}

async function syncNow() {
  clearTimeout(syncTimer);
  if (!cloud.user || !hasContent()) return;
  try {
    await cloud.saveLecture(session, lectureTopic(lectureLang()));
    $("#syncState").textContent = `☁ 已同步 ${hhmm()}`;
  } catch (e) {
    $("#syncState").textContent = "☁ 同步失敗，稍後重試";
    console.warn("[Cloud]", e);
  }
}

async function uploadSegAudio(seg, blob) {
  if (!cloud.user || !blob) return;
  try {
    const path = cloud.audioPath(session.id, session.audio.indexOf(seg), blob.type);
    await cloud.uploadAudio(path, blob);
    seg.cloud = path;
    saveSession();
  } catch (e) {
    setStatus(`音檔上傳失敗（本機仍保留）：${e.message.slice(0, 60)}`, true);
  }
}

// 登入前錄的音檔，登入後補傳
async function uploadPendingAudio() {
  for (const seg of session.audio) {
    if (seg.cloud || !seg.duration) continue;
    const blob = await audioStore.get(seg.key).catch(() => null);
    if (blob) await uploadSegAudio(seg, blob);
  }
}

function renderAccountButton() {
  const btn = $("#btnAccount");
  btn.hidden = !cloud.enabled;
  btn.innerHTML = cloud.user ? '☁<span class="lbl"> 我的課程</span>' : '👤<span class="lbl"> 登入</span>';
  btn.title = cloud.user ? (cloud.user.email || "已登入") : "登入以同步課程、免填 API Key";
}

function openAccount() {
  $("#acctStatus").textContent = "";
  renderAccount();
  $("#accountDlg").showModal();
}

async function renderAccount() {
  const signedIn = !!cloud.user;
  $("#acctOut").hidden = signedIn;
  $("#acctIn").hidden = !signedIn;
  if (!signedIn) return;
  $("#acctWho").textContent = cloud.user.email || "Google 帳號";
  cloud.usageToday().then((n) => { $("#acctUsage").textContent = `今日 AI 使用 ${n} 次`; }).catch(() => {});
  const list = $("#lectureList");
  list.innerHTML = `<p class="hint">載入中…</p>`;
  try {
    const rows = await cloud.listLectures();
    if (!rows.length) { list.innerHTML = `<p class="hint">還沒有雲端紀錄。錄音後會自動同步到這裡。</p>`; return; }
    list.innerHTML = rows.map((r) => `
      <div class="lecture-row${r.id === session.id ? " current" : ""}" data-id="${esc(r.id)}">
        <div class="lr-main"><strong>${esc(r.title || "（未命名課程）")}</strong>
          <small>${esc(r.started_at ? new Date(r.started_at).toLocaleString("zh-TW", { dateStyle: "medium", timeStyle: "short" }) : "")}${r.id === session.id ? "　・目前開啟" : ""}</small></div>
        <div class="lr-act">
          ${r.id === session.id ? "" : `<button type="button" class="ghost small" data-act="open">開啟</button>`}
          <button type="button" class="ghost small danger" data-act="del">刪除</button>
        </div>
      </div>`).join("");
  } catch (e) {
    list.innerHTML = `<p class="hint">讀取失敗：${esc(e.message)}</p>`;
  }
}

async function openLecture(id) {
  if (running) { $("#acctStatus").textContent = "錄音中無法切換課程，請先停止錄音"; return; }
  $("#acctStatus").textContent = "開啟中…";
  try {
    await syncNow();
    const data = await cloud.getLecture(id);
    store.set("session", data);
    location.reload();                    // 重新載入畫面，顯示這堂課
  } catch (e) {
    $("#acctStatus").textContent = `開啟失敗：${e.message}`;
  }
}

async function deleteLecture(id) {
  if (!confirm("確定刪除這堂課的雲端紀錄與音檔？此動作無法復原。")) return;
  try {
    await cloud.deleteLecture(id);
    if (id === session.id) delete session.cloudSaved;
    renderAccount();
  } catch (e) {
    $("#acctStatus").textContent = `刪除失敗：${e.message}`;
  }
}

function bindAccount() {
  $("#btnAccount").addEventListener("click", openAccount);
  $("#btnAcctClose").addEventListener("click", () => $("#accountDlg").close());
  $("#btnGoogle").addEventListener("click", async () => {
    const { error } = await cloud.signInWithGoogle();
    if (error) $("#acctStatus").textContent = `Google 登入失敗：${error.message}`;
  });
  $("#btnSendCode").addEventListener("click", async () => {
    const email = $("#acctEmail").value.trim();
    if (!/^\S+@\S+\.\S+$/.test(email)) { $("#acctStatus").textContent = "請輸入正確的 Email"; return; }
    $("#acctStatus").textContent = "寄送中…";
    const { error } = await cloud.sendEmailCode(email);
    if (error) { $("#acctStatus").textContent = `寄送失敗：${error.message}`; return; }
    $("#codeRow").hidden = false;
    $("#acctStatus").textContent = "已寄出。請輸入信中的驗證碼，或直接點信中的登入連結。";
    $("#acctCode").focus();
  });
  $("#btnVerify").addEventListener("click", async () => {
    const { error } = await cloud.verifyEmailCode($("#acctEmail").value.trim(), $("#acctCode").value.trim());
    if (error) $("#acctStatus").textContent = `驗證失敗：${error.message}`;
  });
  $("#btnSignOut").addEventListener("click", async () => {
    await syncNow();
    await cloud.signOut();
  });
  $("#lectureList").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-act]");
    if (!btn) return;
    const id = btn.closest(".lecture-row").dataset.id;
    if (btn.dataset.act === "open") openLecture(id);
    else deleteLecture(id);
  });
}

async function initCloud() {
  renderAccountButton();
  if (!cloud.enabled) return;
  try { await cloud.init(); } catch (e) { console.warn("[Cloud] init", e); return; }
  const onUser = async (user) => {
    renderAccountButton();
    refreshGemini();
    updateEngineLabel();
    if ($("#accountDlg").open) renderAccount();
    if (user) {
      setStatus(`已登入 ${user.email || ""}，課程會自動同步到雲端`);
      await syncNow();
      uploadPendingAudio();
    }
  };
  cloud.onChange(onUser);
  if (cloud.user) onUser(cloud.user);
}

/* ───────────── 初始化 ───────────── */
function showTab(tab) {
  document.querySelectorAll(".tabs button").forEach((x) => x.classList.toggle("active", x.dataset.tab === tab));
  document.querySelectorAll(".pane").forEach((p) => p.classList.toggle("active", p.id === `pane-${tab}`));
}

function restoreSession() {
  session.questions ??= [];
  session.lines.forEach((l) => appendLine($("#transcript"), l));
  showPlayer();
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
    if (cloud.user) await syncNow();                      // 已登入：舊課程留在雲端，本機音檔可清掉
    await audioStore.removeSession(session.id).catch(() => {});
    session = emptySession();
    store.set("session", session);
    location.reload();
  });
  $("#chkTranslate").addEventListener("change", (e) => {
    cfg.translate = e.target.checked;
    store.set("cfg", cfg);
    applyTranslateUi();
  });
  $("#setHandout").addEventListener("change", (e) => {
    loadHandout(e.target.files);
    e.target.value = "";
  });
  $("#btnClearHandout").addEventListener("click", () => {
    handout = { names: [], outline: "", terms: [] };
    store.set("handout", handout);
    renderHandout();
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
    if (cloud.user && hasContent()) syncNow();
    if (running) { e.preventDefault(); e.returnValue = ""; }
  });
}

bind();
bindSplitter();
bindPlayer();
bindAccount();
initCloud();
applyTranslateUi();
showTab("transcript");
restoreSession();
updateEngineLabel();
setStatus(cfg.key ? "就緒 ✓  按「開始錄音」開始"
  : cloud.enabled ? "請先登入（右上「👤 登入」），或在設定中輸入自己的 Gemini API Key"
  : "請先在設定中輸入 Gemini API Key");
if (!cfg.key && !cloud.enabled) openSettings();

if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}

// 測試用：網址加上 ?debug 可從主控台注入文字
if (new URLSearchParams(location.search).has("debug")) {
  window.lecture = { onFinal, genNarrative, genDiagram, genQuestions, flushTranslation, startRecorder, stopRecorder, playFrom, player, session: () => session, setRunning: (v) => (running = v), cloud, refreshGemini, renderAccountButton, openAccount, syncNow, gemini: () => gemini };
}
