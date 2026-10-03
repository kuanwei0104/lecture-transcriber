// 帳號登入、課程紀錄雲端同步、音檔上傳、後端代呼叫 AI（Supabase）
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";

const SDK = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.2/+esm";

export const cloud = {
  enabled: !!(SUPABASE_URL && SUPABASE_ANON_KEY),
  client: null,
  user: null,
  listeners: [],

  async init() {
    if (!this.enabled) return;
    const { createClient } = await import(SDK);
    this.client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { flowType: "pkce", persistSession: true, detectSessionInUrl: true },
    });
    const { data } = await this.client.auth.getSession();
    this.user = data.session?.user ?? null;
    this.client.auth.onAuthStateChange((event, s) => {
      const before = this.user?.id;
      this.user = s?.user ?? null;
      if (before !== this.user?.id) this.listeners.forEach((fn) => fn(this.user, event));
    });
  },

  onChange(fn) { this.listeners.push(fn); },

  /* ── 登入 ── */
  signInWithGoogle() {
    return this.client.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: location.origin + location.pathname },
    });
  },
  sendEmailCode(email) {
    return this.client.auth.signInWithOtp({
      email,
      options: { shouldCreateUser: true, emailRedirectTo: location.origin + location.pathname },
    });
  },
  verifyEmailCode(email, token) {
    return this.client.auth.verifyOtp({ email, token, type: "email" });
  },
  signOut() { return this.client.auth.signOut(); },

  /* ── 課程紀錄 ── */
  async listLectures() {
    const { data, error } = await this.client.from("lectures")
      .select("id, title, started_at, updated_at")
      .order("updated_at", { ascending: false })
      .limit(200);
    if (error) throw error;
    return data;
  },
  async getLecture(id) {
    const { data, error } = await this.client.from("lectures").select("data").eq("id", id).single();
    if (error) throw error;
    return data.data;
  },
  async saveLecture(session, title) {
    const { error } = await this.client.from("lectures").upsert({
      id: session.id,
      user_id: this.user.id,
      title,
      started_at: session.started ? new Date(session.started).toISOString() : null,
      data: session,
      updated_at: new Date().toISOString(),
    });
    if (error) throw error;
  },
  async deleteLecture(id) {
    const folder = `${this.user.id}/${id}`;
    const { data: files } = await this.client.storage.from("audio").list(folder);
    if (files?.length) await this.client.storage.from("audio").remove(files.map((f) => `${folder}/${f.name}`));
    const { error } = await this.client.from("lectures").delete().eq("id", id);
    if (error) throw error;
  },

  /* ── 音檔 ── */
  audioPath(sessionId, seg, mime) {
    const ext = /mp4/.test(mime) ? "m4a" : /ogg/.test(mime) ? "ogg" : "webm";
    return `${this.user.id}/${sessionId}/${seg}.${ext}`;
  },
  async uploadAudio(path, blob) {
    const { error } = await this.client.storage.from("audio")
      .upload(path, blob, { upsert: true, contentType: blob.type || "audio/webm" });
    if (error) throw error;
  },
  async downloadAudio(path) {
    const { data, error } = await this.client.storage.from("audio").download(path);
    if (error) throw error;
    return data;
  },

  /* ── AI 用量 ── */
  async usageToday() {
    const today = new Date().toLocaleDateString("en-CA");          // YYYY-MM-DD
    const { data } = await this.client.from("ai_usage").select("calls").eq("day", today).maybeSingle();
    return data?.calls ?? 0;
  },

  // 給 Gemini 類別用的傳輸函式：改走後端，不需要使用者的 API Key
  aiProxy: async (model, body) => {
    const { data } = await cloud.client.auth.getSession();
    const token = data.session?.access_token;
    if (!token) return new Response(JSON.stringify({ error: { code: 401, message: "請先登入" } }), { status: 401 });
    return fetch(`${SUPABASE_URL}/functions/v1/gemini`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, apikey: SUPABASE_ANON_KEY },
      body: JSON.stringify({ model, body }),
    });
  },
};
