// 錄下課堂音檔（存在瀏覽器的 IndexedDB），讓逐字稿可以點一句就跳到那個時間點播放

const DB_NAME = "lecture-audio", STORE = "clips";

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const result = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(result?.result ?? result);
    t.onerror = () => reject(t.error);
  });
}

export const audioStore = {
  put: (key, blob) => tx("readwrite", (s) => s.put(blob, key)),
  get: (key) => tx("readonly", (s) => s.get(key)),
  // 刪掉某堂課的所有音檔（key 以 `${sessionId}:` 開頭）
  async removeSession(sessionId) {
    const db = await openDb();
    return new Promise((resolve) => {
      const t = db.transaction(STORE, "readwrite");
      const range = IDBKeyRange.bound(`${sessionId}:`, `${sessionId};`);
      t.objectStore(STORE).delete(range);
      t.oncomplete = resolve;
      t.onerror = resolve;
    });
  },
};

const pickMime = () => ["audio/webm;codecs=opus", "audio/mp4", "audio/webm", "audio/ogg;codecs=opus"]
  .find((m) => window.MediaRecorder?.isTypeSupported?.(m)) || "";

/* 錄音：每次「開始錄音 → 停止」是一段（segment） */
export class ClipRecorder {
  static supported() { return !!(window.MediaRecorder && navigator.mediaDevices?.getUserMedia); }

  async start(stream) {
    // 已經有麥克風串流（Gemini 音訊辨識）就共用，否則自己開
    this.ownStream = !stream;
    this.stream = stream || await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });
    this.mime = pickMime();
    this.chunks = [];
    this.rec = new MediaRecorder(this.stream, this.mime ? { mimeType: this.mime, audioBitsPerSecond: 32000 } : undefined);
    this.rec.ondataavailable = (e) => { if (e.data.size) this.chunks.push(e.data); };
    this.rec.start(5000);                 // 每 5 秒交一塊，避免長時間錄音全部塞在記憶體最後才處理
    this.startedAt = Date.now();
    return this.startedAt;
  }

  stop() {
    return new Promise((resolve) => {
      if (!this.rec || this.rec.state === "inactive") { resolve(null); return; }
      this.rec.onstop = () => {
        if (this.ownStream) this.stream.getTracks().forEach((t) => t.stop());
        resolve(new Blob(this.chunks, { type: this.rec.mimeType || this.mime || "audio/webm" }));
      };
      this.rec.stop();
    });
  }
}

/* 播放器：一次載入一段音檔，從指定秒數開始播 */
export class ClipPlayer {
  constructor({ onTime, onState }) {
    this.audio = new Audio();
    this.audio.preload = "auto";
    this.onTime = onTime;
    this.onState = onState;
    this.seg = null;
    this.url = null;
    this.audio.addEventListener("timeupdate", () => this.onTime(this.seg, this.audio.currentTime, this.audio.duration));
    this.audio.addEventListener("play", () => this.onState(true));
    this.audio.addEventListener("pause", () => this.onState(false));
    this.audio.addEventListener("ended", () => this.onState(false));
  }

  async load(seg, key) {
    if (this.seg === seg && this.url) return true;
    const blob = await audioStore.get(key);
    if (!blob) return false;
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = URL.createObjectURL(blob);
    this.audio.src = this.url;
    this.seg = seg;
    await new Promise((r) => {
      this.audio.addEventListener("loadedmetadata", r, { once: true });
      this.audio.addEventListener("error", r, { once: true });
    });
    return true;
  }

  async playAt(seconds) {
    try { this.audio.currentTime = Math.max(0, seconds); } catch { /* 尚未可跳轉 */ }
    await this.audio.play().catch(() => {});
  }

  toggle() { this.audio.paused ? this.audio.play().catch(() => {}) : this.audio.pause(); }
  pause() { this.audio.pause(); }
  seek(seconds) { this.audio.currentTime = seconds; }
  set rate(r) { this.audio.playbackRate = r; }
}
