// 後端代呼叫 Gemini：使用者登入後不需要自己的 API Key
// 部署：supabase functions deploy gemini
// 需要的 secret：GEMINI_API_KEY（必填）、DAILY_LIMIT（每人每天上限，預設 200）

import { createClient } from "jsr:@supabase/supabase-js@2";

// 只允許前端實際會用到的模型，避免被拿去呼叫昂貴模型
const ALLOWED = new Set([
  "gemini-3.5-flash-lite", "gemini-flash-lite-latest", "gemini-3.1-flash-lite",
  "gemini-3.6-flash", "gemini-3.5-flash", "gemini-flash-latest",
]);

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Expose-Headers": "x-usage-today, x-usage-limit",
};

const json = (status: number, error: Record<string, unknown>) =>
  new Response(JSON.stringify({ error }), { status, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json(405, { code: 405, message: "method not allowed" });

  const geminiKey = Deno.env.get("GEMINI_API_KEY");
  if (!geminiKey) return json(500, { code: 500, message: "伺服器尚未設定 GEMINI_API_KEY" });

  // 驗證登入
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data: { user }, error: authError } = await admin.auth.getUser(token);
  if (authError || !user) return json(401, { code: 401, message: "請先登入" });

  let payload: { model?: string; body?: unknown };
  try {
    payload = await req.json();
  } catch {
    return json(400, { code: 400, message: "invalid JSON" });
  }
  const { model, body } = payload ?? {};
  if (!model || !ALLOWED.has(model) || !body) return json(400, { code: 400, message: "model not allowed" });

  // 每人每天的使用上限
  const limit = Number(Deno.env.get("DAILY_LIMIT") ?? "200");
  const { data: used, error: usageError } = await admin.rpc("bump_ai_usage", { p_user: user.id, p_limit: limit });
  if (usageError) return json(500, { code: 500, message: `usage: ${usageError.message}` });
  if (used === -1) {
    return json(429, {
      code: 429, status: "DAILY_LIMIT",
      message: `今日 AI 使用次數已達上限（${limit} 次），明天會自動重置`,
    });
  }

  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": geminiKey },
    body: JSON.stringify(body),
  });
  return new Response(await r.text(), {
    status: r.status,
    headers: {
      ...cors,
      "Content-Type": "application/json",
      "x-usage-today": String(used),
      "x-usage-limit": String(limit),
    },
  });
});
