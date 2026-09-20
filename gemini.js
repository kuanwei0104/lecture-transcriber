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

  // 匯出用：整堂課的心智圖結構
  async mindmap(content, lang = "zh") {
    const instr = lang === "en"
      ? `Below is the full content of a lecture (polished notes and/or transcript):

${content}

Summarise the whole lecture as a mind map. Return JSON, written entirely in English:
{
  "root": "Central topic (max 5 words)",
  "branches": [
    {"title": "Main branch (max 4 words)", "children": ["Key point (max 7 words)", "..."]}
  ]
}

Rules:
1. 4–7 branches covering the whole lecture in the order it was taught
2. 2–5 children per branch; keep formulas and technical terms as they were said
3. Keep every label short — this is a diagram, not sentences
4. Only use what is in the lecture; do not invent content`
      : `以下是一堂課的完整內容（精修順稿與逐字稿）：

${content}

請把整堂課整理成一張心智圖。以 JSON 回傳（全部使用繁體中文，術語可保留英文）：
{
  "root": "中心主題（8字內）",
  "branches": [
    {"title": "主要分支（6字內）", "children": ["重點（12字內）", "..."]}
  ]
}

規則：
1. 依授課順序給 4–7 個分支，涵蓋整堂課
2. 每個分支 2–5 個子項目；公式與術語照原樣保留
3. 標籤要短，這是圖不是句子
4. 只根據課堂內容，不要捏造`;
    const raw = await this.ask({ system: lang === "en" ? "You are an expert at structuring lecture content. Output pure JSON only."
                                                       : "你是擅長整理課程架構的助教，只輸出純 JSON。",
                                 parts: [{ text: instr }], smart: true, json: true });
    const tree = JSON.parse(raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, ""));
    if (!tree?.branches?.length) throw new Error("心智圖格式錯誤");
    return tree;
  }

  // 匯出用：翻譯 markdown 順稿，保留格式
  async translateMarkdown(md, target) {
    const system = target === "en"
      ? `You are an academic translator. Translate the lecture notes below into natural academic English.
Rules: keep the Markdown structure exactly (## headings, **bold**, \`code\`, > quotes, numbered and bulleted lists, line breaks);
write terms like 紊流（Turbulence） simply as the English term; keep formulas unchanged;
if a line already has parallel Chinese and English versions, keep only the English; output only the translated Markdown.`
      : `你是學術翻譯。把以下課堂筆記翻譯成自然流暢的繁體中文（台灣用語）。
規則：完整保留 Markdown 結構（## 標題、**粗體**、\`程式碼\`、> 引文、列表、換行）；專有名詞第一次出現時附英文，如：長期增強作用（LTP）；公式保持原樣；
若某行已同時有中英對照，只保留中文；只輸出翻譯後的 Markdown。`;
    let out = await this.ask({ system, parts: [{ text: md }], smart: true });
    return out.replace(/^```(?:markdown|md)?\s*/i, "").replace(/```\s*$/, "").trim();
  }

  // 匯出用：翻譯 JSON 裡所有文字值（圖解、課後提問），鍵名與結構不變
  async translateJson(obj, target) {
    const lang = target === "en" ? "natural academic English" : "繁體中文（台灣用語），專有名詞可附英文";
    const raw = await this.ask({
      system: "You are an academic translator. Output pure JSON only.",
      parts: [{ text: `Translate every string value in this JSON into ${lang}. Keep all keys, array lengths and structure identical; keep formulas unchanged.\n\n${JSON.stringify(obj)}` }],
      smart: true, json: true,
    });
    return JSON.parse(raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, ""));
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

  async polishNarrative(raw, prevTitles, lang = "zh") {
    const prev = prevTitles.length ? prevTitles.slice(-6).map((t) => `- ${t}`).join("\n") : (lang === "en" ? "(none yet)" : "（尚無）");
    const instr = lang === "en" ? `You are an academic editor. Turn the spoken lecture transcript below into polished, well-structured lecture notes in English.

[Style example]
## Introduction: Three Major Challenges
I think the challenges we face today come mainly from three different fields.
First, in the physical sciences, there is a problem that has never been solved: turbulence.
Second, in the social sciences, the corresponding problem is the stock market.
Third, in medicine, it is our brain signals, that is, the EEG.
> These three problems share one thing in common: they are all random signals.

[Formatting rules]
1. Split the transcript into 1–3 sections, each starting with \`## Heading\` (max 6 words)
2. Remove filler words ("um", "you know", "like", "so", "right") and false starts, but keep the speaker's first-person voice
3. Write formulas as plain Unicode inside backticks, e.g. \`z = (x̄ − μ) / (σ/√n)\`; never use LaTeX ($, \\frac, etc.); write Greek letters directly as α, β, μ
4. Use **bold** for points the speaker clearly emphasizes
5. Use \`> quote\` for side notes, asides and examples
6. Use \`1.\` \`2.\` or \`-\` for lists
7. The transcript comes from live speech recognition and may contain misheard words; fix them from context
8. Stay faithful to what the speaker actually said — do not add facts, mechanisms or examples that are not in the transcript
9. Output only Markdown in English — no explanations, no JSON

[Sections already written (avoid repeating these headings, but you may continue the topic)]
${prev}

[This part of the transcript]
${raw}

Output the polished Markdown notes:` : `你是學術編輯。把以下口語化的課堂逐字稿，整理成正式的「順稿」格式（繁體中文輸出）。

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
9. 不要加任何說明文字、不要 JSON、直接輸出 markdown

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

  async questions(content, count = 8, lang = "zh") {
    const n = Math.min(20, Math.max(1, Math.round(count) || 8));
    const en = lang === "en";
    const instr = en
      ? `Below is the content of a lecture/talk (polished notes and/or raw transcript):

${content}

Write follow-up questions that could be asked to the speaker or discussed with classmates. Return JSON:
{
  "summary": "One-sentence summary of the key point of the lecture, in English (max 25 words)",
  "summary_zh": "The same summary translated into Traditional Chinese (Taiwan)",
  "questions": [
    {"q": "Question in English", "q_zh": "The same question translated into Traditional Chinese (Taiwan); keep technical terms in English in parentheses", "context": "Which part of the lecture it refers to, in English (max 10 words)"}
  ]
}

Rules:
1. Exactly ${n} questions, not grouped into categories
2. Mix question types: clarifying unclear points, going deeper into underlying principles, real-world applications or examples, reasonable challenges to the argument, open-ended discussion
3. Be specific and tied to the lecture content; avoid vague questions like "What do you think?"
4. Max 35 words each, natural enough to ask out loud
5. The notes may be in Chinese, but "summary", "q" and "context" must be in English; only "summary_zh" and "q_zh" are in Traditional Chinese, as faithful translations
6. If the content is an ad or small talk, still base the questions on what was actually said`
      : `以下是一堂課／演講的內容（精修順稿與逐字稿）：

${content}

請根據內容產生「課後提問」，可用來詢問講者或和同學討論。以 JSON 回傳（全部使用繁體中文，術語可附英文）：
{
  "summary": "一句話總結本堂重點（40字內）",
  "questions": [
    {"q": "問題", "context": "對應講稿中的哪段內容（20字內）"}
  ]
}

規則：
1. questions 剛好 ${n} 題，不要分類
2. 題目類型盡量多元：釐清沒講清楚的地方、延伸到更深的原理、實際應用或例子、對論點的合理質疑、開放式的觀點討論
3. 問題要具體、扣緊講稿內容，不要空泛（避免「你怎麼看？」這類問題）
4. 每題 60 字內，語氣自然、可以直接念出來
5. 若內容是廣告或閒聊，也照實根據內容出題`;
    const system = en
      ? "You are a teaching assistant who is great at guiding discussion. Output pure JSON only."
      : "你是擅長引導討論的助教，只輸出純 JSON。";
    let raw = await this.ask({ system, parts: [{ text: instr }], smart: true, json: true });
    raw = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
    const data = JSON.parse(raw);
    if (!data?.questions?.length) throw new Error("問題格式錯誤");
    data.questions = data.questions.slice(0, n);
    return data;
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
