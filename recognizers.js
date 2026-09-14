// 兩種語音辨識引擎，介面相同：start() / stop()，透過 callback 回報
//   onInterim(text)  辨識中（灰字，會被覆蓋）
//   onFinal(text)    確認的句子
//   onStatus(msg)    暫時性狀態
//   onError(msg)     無法繼續（例如權限被拒）

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

/* ───────────── 瀏覽器內建語音辨識（Web Speech API） ───────────── */
export class BrowserRecognizer {
  static supported() { return !!SR; }

  constructor({ lang, onInterim, onFinal, onStatus, onError }) {
    Object.assign(this, { lang, onInterim, onFinal, onStatus, onError });
    this.active = false;
    this.rec = null;
    this.failures = 0;
  }

  start() {
    this.active = true;
    this._spawn();
    // iOS Safari 常常一直不給 isFinal；灰字 2 秒沒變就主動結束這一輪，讓它送出結果
    this.watchdog = setInterval(() => {
      const stale = Date.now() - this.pendingAt;
      if (this.pending && (stale > 2000 || (this.pending.length > 150 && stale > 600))) {
        try { this.rec?.stop(); } catch { /* ignore */ }
        this.pendingAt = Date.now();
      }
    }, 500);
  }

  _spawn() {
    if (!this.active) return;
    const rec = new SR();
    rec.lang = this.lang;
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    const done = new Set();          // 本輪已送出的 result index（iOS 會重複回傳舊結果）
    this.pending = "";

    rec.onstart = () => { this.failures = 0; this.onStatus("  錄音中…"); };
    rec.onresult = (e) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        const t = res[0].transcript;
        if (res.isFinal) {
          if (!done.has(i)) { done.add(i); this.onFinal(t); }
        } else {
          interim += t;
        }
      }
      if (interim !== this.pending) { this.pending = interim; this.pendingAt = Date.now(); }
      this.onInterim(interim);
    };
    rec.onerror = (e) => {
      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        this.active = false;
        this.onError("麥克風或語音辨識權限被拒絕。iPhone 請到「設定 › Safari › 麥克風」允許，並確認「Siri 與聽寫」已開啟；或改用設定中的「Gemini 音訊辨識」。");
      } else if (e.error === "language-not-supported") {
        this.active = false;
        this.onError("此瀏覽器不支援所選語言的語音辨識，請改用「Gemini 音訊辨識」。");
      } else if (e.error !== "no-speech" && e.error !== "aborted") {
        this.failures++;
        this.onStatus(`語音辨識暫時中斷（${e.error}），自動重新連線中…`);
      }
    };
    rec.onend = () => {
      if (this.pending) { this.onFinal(this.pending); this.pending = ""; }   // 未確認的灰字直接收下
      this.onInterim("");
      if (this.active) setTimeout(() => this._spawn(), Math.min(250 * 2 ** this.failures, 5000));
    };
    try {
      rec.start();
      this.rec = rec;
    } catch (err) {
      this.failures++;
      setTimeout(() => this._spawn(), 1000);
    }
  }

  stop() {
    this.active = false;
    clearInterval(this.watchdog);
    try { this.rec?.stop(); } catch { /* ignore */ }
  }
}

/* ───────────── Gemini 音訊辨識：收音 → 依停頓切段 → 上傳 Gemini ───────────── */
const TARGET_RATE = 16000;
const MIN_SEC = 6, MAX_SEC = 20, END_SILENCE = 0.8;

export class GeminiAudioRecognizer {
  static supported() {
    return !!(navigator.mediaDevices?.getUserMedia && (window.AudioContext || window.webkitAudioContext));
  }

  constructor({ gemini, lang, onInterim, onFinal, onStatus, onError }) {
    Object.assign(this, { gemini, lang, onInterim, onFinal, onStatus, onError });
    this.queue = Promise.resolve();
    this.inflight = 0;
  }

  async start() {
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (e) {
      this.onError(`無法使用麥克風：${e.message}。請允許瀏覽器使用麥克風。`);
      return false;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AC();
    await this.ctx.resume();
    const src = this.ctx.createMediaStreamSource(this.stream);
    const proc = this.ctx.createScriptProcessor(4096, 1, 1);
    const mute = this.ctx.createGain();
    mute.gain.value = 0;
    src.connect(proc); proc.connect(mute); mute.connect(this.ctx.destination);
    this.proc = proc;
    this._reset();
    this.floor = 0.01;

    proc.onaudioprocess = (e) => {
      const x = e.inputBuffer.getChannelData(0);
      const d = downsample(x, this.ctx.sampleRate);
      let sum = 0;
      for (let i = 0; i < x.length; i++) sum += x[i] * x[i];
      const rms = Math.sqrt(sum / x.length);
      // 自動估計環境噪音
      this.floor = rms < this.floor ? rms : this.floor + (rms - this.floor) * 0.002;
      const speaking = rms > Math.max(0.006, this.floor * 2.5);
      const sec = d.length / TARGET_RATE;
      if (speaking) { this.speech += sec; this.silence = 0; } else { this.silence += sec; }
      this.chunks.push(d); this.len += d.length;

      const dur = this.len / TARGET_RATE;
      if ((dur >= MIN_SEC && this.silence >= END_SILENCE && this.speech >= 1) || dur >= MAX_SEC) {
        this._cut();
      } else if (this.speech < 0.3 && dur >= 4) {
        this._reset();                            // 一直沒人說話就丟掉
      }
      this._showInterim(dur);
    };
    return true;
  }

  _reset() { this.chunks = []; this.len = 0; this.speech = 0; this.silence = 0; }

  _showInterim(dur = this.len / TARGET_RATE) {
    const parts = [];
    if (this.speech >= 0.3) parts.push(`🎙 收音中 ${Math.floor(dur)} 秒`);
    if (this.inflight) parts.push("⏳ Gemini 辨識中…");
    this.onInterim(parts.join("　"));
  }

  _cut() {
    if (this.speech < 0.5) { this._reset(); return; }
    const wav = encodeWav(this.chunks, this.len);
    this._reset();
    this.inflight++;
    this.queue = this.queue.then(async () => {      // 依序處理，保持句子順序
      try {
        const text = await this.gemini.transcribeAudio(toBase64(wav), this.lang);
        if (text) this.onFinal(text);
      } catch (e) {
        this.onStatus(`語音辨識失敗（稍後繼續）：${e.message.slice(0, 80)}`);
      } finally {
        this.inflight--;
        this._showInterim();
      }
    });
  }

  async stop() {
    if (this.proc) {
      this.proc.onaudioprocess = null;
      if (this.len) this._cut();
    }
    this.stream?.getTracks().forEach((t) => t.stop());
    try { await this.ctx?.close(); } catch { /* ignore */ }
    await this.queue;
    this.onInterim("");
  }
}

function downsample(input, rate) {
  if (rate === TARGET_RATE) return new Float32Array(input);
  const ratio = rate / TARGET_RATE;
  const out = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const start = Math.floor(i * ratio), end = Math.min(input.length, Math.floor((i + 1) * ratio));
    let s = 0;
    for (let j = start; j < end; j++) s += input[j];
    out[i] = s / Math.max(1, end - start);
  }
  return out;
}

function encodeWav(chunks, len) {
  const buf = new ArrayBuffer(44 + len * 2);
  const v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, "RIFF"); v.setUint32(4, 36 + len * 2, true); str(8, "WAVE");
  str(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, TARGET_RATE, true); v.setUint32(28, TARGET_RATE * 2, true);
  v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, "data"); v.setUint32(40, len * 2, true);
  let o = 44;
  for (const c of chunks) {
    for (let i = 0; i < c.length; i++, o += 2) {
      const s = Math.max(-1, Math.min(1, c[i]));
      v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
  }
  return new Uint8Array(buf);
}

function toBase64(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
