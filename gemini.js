import { sleep } from "./util.js";

const BASE = "https://generativelanguage.googleapis.com/v1beta/models/";

// 模型備援清單：舊模型會被 Google 下架，依序嘗試
const FAST_MODELS  = ["gemini-3.5-flash-lite", "gemini-flash-lite-latest", "gemini-3.1-flash-lite",
                      "gemini-3.6-flash", "gemini-flash-latest"];
const SMART_MODELS = ["gemini-3.6-flash", "gemini-3.5-flash", "gemini-flash-latest",
                      "gemini-3.5-flash-lite", "gemini-flash-lite-latest"];

class FatalError extends Error {}

export class Gemini {
  constructor(apiKey) {
    this.key = apiKey;
    this.dead = new Set();      // 回傳 404（已下架）的模型
    this.lastModel = "";
  }

  async ask({ system = "", parts, smart = false, json = false, allowEmpty = false }) {
    const chain = smart ? SMART_MODELS : FAST_MODELS;
    const body = { contents: [{ role: "user", parts }] };
    if (system) body.systemInstruction = { parts: [{ text: system }] };
    if (json) body.generationConfig = { responseMimeType: "application/json" };
    let last;
    for (let attempt = 0; attempt < 2; attempt++) {
      for (const model of chain) {
        if (this.dead.has(model)) continue;
        try {
          const r = await fetch(`${BASE}${model}:generateContent`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-goog-api-key": this.key },
            body: JSON.stringify(body),
          });
          const data = await r.json().catch(() => ({}));
          if (!r.ok) {
            const msg = data?.error?.message || r.statusText;
            if (r.status === 404) this.dead.add(model);
            if ((r.status === 400 && /api key/i.test(msg)) || r.status === 401 || r.status === 403)
              throw new FatalError(`API Key 無效或沒有權限：${msg}`);
            throw new Error(`${r.status} ${msg}`);
          }
          const text = (data.candidates?.[0]?.content?.parts || [])
            .filter((p) => !p.thought).map((p) => p.text || "").join("").trim();
          if (!text && !allowEmpty) throw new Error("回傳內容為空");
          this.lastModel = model;
          return text;
        } catch (e) {
          if (e instanceof FatalError) throw e;
          last = e;
          console.warn(`[Gemini] ${model}:`, e.message);
        }
      }
      if (attempt === 0) await sleep(4000);   // 可能是暫時性 429 / 503
    }
    throw new Error(`Gemini 所有模型都失敗：${last?.message || "沒有可用的模型"}`);
  }

  translate(text, target) {
    const system = target === "en"
      ? "You are an academic translator. Translate the Chinese lecture transcript into natural English. Output only the translation."
      : "你是學術翻譯。將英文課堂逐字稿翻成繁體中文。規則：①自然流暢 ②專有名詞保留英文 ③直接輸出譯文";
    return this.ask({ system, parts: [{ text }] });
  }

  async transcribeAudio(base64Wav, lang) {
    const prompt = lang.startsWith("zh")
      ? "請把這段課堂錄音逐字轉寫成繁體中文（英文術語保留英文）。只輸出講者說的話，不要加任何說明、標題或時間戳。若沒有可辨識的語音，輸出空字串。"
      : "Transcribe this lecture audio verbatim in English. Output only the spoken words, no notes or timestamps. If there is no intelligible speech, output an empty string.";
    const text = await this.ask({
      parts: [{ text: prompt }, { inlineData: { mimeType: "audio/wav", data: base64Wav } }],
      allowEmpty: true,
    });
    return text.replace(/^["「]|["」]$/g, "").trim();
  }

  async polishNarrative(raw, prevTitles) {
    const prev = prevTitles.length ? prevTitles.slice(-6).map((t) => `- ${t}`).join("\n") : "（尚無）";
    const instr = `你是學術編輯。把以下口語化的課堂逐字稿，整理成正式的「順稿」格式（繁體中文輸出）。

【格式範例】
## 課程介紹：三大挑戰
我覺得我們現在面對的挑戰主要有三個，分別來自不同的領域。
第一個，在物理科學方面，有一個從來沒有被解決的問題，那就是「紊流」（Turbulence）。
第二個，在社會科學方面，對應的問題就是「股市」。
第三個，在醫學方面，就是我們的「腦電」，也就是腦波（EEG）。
> 這三個問題其實有一個共通點：它們都是隨機訊號。

【格式規則】
1. 一段逐字稿可切成 1~3 個小節，每節用 \`## 標題\`（10字內）
2. 移除口語贅詞（「那個」「就是說」「對」「然後」「嗯」等），但保留講者第一人稱語氣
3. 第一次出現的專有名詞要附英文：例：紊流（Turbulence）
4. 公式用 Unicode 純文字放在反引號內：例：\`z = (x̄ − μ) / (σ/√n)\`；禁止使用 LaTeX 語法（不要出現 $、\\frac 等），希臘字母直接寫 α、β、μ
5. 講者明顯強調的重點用 **粗體**
6. 旁註、補充、舉例可用 \`> 引文\` 標記
7. 列舉用 \`1.\` \`2.\` 或 \`-\`
8. 逐字稿來自即時語音辨識，常有同音錯字，請依上下文修正
9. 若逐字稿是英文，也請整理成繁體中文順稿
10. 不要加任何說明文字、不要 JSON、直接輸出 markdown

【已產生的章節（避免重複命名，但可延續主題）】
${prev}

【本段逐字稿】
${raw}

請直接輸出整理好的 markdown 順稿：`;
    let md = await this.ask({ parts: [{ text: instr }], smart: true });
    md = md.replace(/^```(?:markdown|md)?\s*/i, "").replace(/```\s*$/, "").trim();
    const titles = [...md.matchAll(/^##\s+(.+?)$/gm)].map((m) => m[1]);
    return { markdown: md, titles };
  }

  async diagramSpec(text) {
    const instr = `以下是課堂最近幾分鐘的講稿：

${text}

請整理成一張「課堂講義風格」的圖解，以 JSON 回傳：
{
  "title_zh": "圖解標題（12字內，繁體中文，術語可保留英文）",
  "subtitle_en": "English subtitle (max 8 words)",
  "concept_zh": "核心概念摘要，2-3句繁體中文，術語保留英文",
  "panels": [
    {"heading": "小標題（10字內）", "bullets": ["重點（25字內，術語附英文，如：虛無假設（H0））", "..."]}
  ],
  "flow": ["步驟一（12字內）", "步驟二", "步驟三"],
  "formula": "若講稿有公式則以 Unicode 純文字寫出，如 z = (x̄ − μ) / (σ/√n)；沒有則為空字串",
  "key_terms": ["術語1（English）", "術語2（English）", "術語3（English）"]
}

規則：panels 2-3 個、每個 2-4 條 bullets；flow 為講稿中的流程或因果順序（2-5 步，沒有則為空陣列）；
只根據講稿內容，不要捏造；若講稿是廣告或閒聊，也照實摘要。`;
    let raw = await this.ask({ system: "你是教學設計師，只輸出純 JSON。", parts: [{ text: instr }], smart: true, json: true });
    raw = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
    const spec = JSON.parse(raw);
    if (!spec || typeof spec !== "object") throw new Error("圖解 JSON 格式錯誤");
    return spec;
  }
}
