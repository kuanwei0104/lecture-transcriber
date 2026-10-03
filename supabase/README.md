# 開啟帳號登入、雲端同步與後端 AI（Supabase 設定）

完成後：使用者用 Google 或 Email 驗證碼登入，課程紀錄與音檔自動同步到雲端、可跨裝置開啟，而且不用自己申請 Gemini API Key。
全部在瀏覽器裡操作，約 30–40 分鐘。還沒設定前，網站照舊運作（使用者自填 API Key）。

## 1. 建立 Supabase 專案

1. 到 <https://supabase.com> 註冊並登入，按 **New project**。
2. Region 選 **Northeast Asia (Tokyo)** 或 **Southeast Asia (Singapore)**（離台灣近）。
3. 資料庫密碼自己設定並記下來（之後用不到，但遺失無法找回）。

## 2. 建立資料表與權限

1. 左側 **SQL Editor** → **New query**。
2. 把 `supabase/migrations/20261003000000_init.sql` 的內容全部貼上，按 **Run**。
3. 看到 `Success. No rows returned` 就完成了。

## 3. 部署後端 AI 函式

1. 左側 **Edge Functions** → **Deploy a new function** → **Via Editor**。
2. 函式名稱填 **`gemini`**（一定要是這個名字）。
3. 把 `supabase/functions/gemini/index.ts` 的內容全部貼上，按 **Deploy function**。
4. 同一頁的 **Secrets**（或 Edge Functions → Manage secrets）新增：

| 名稱 | 值 |
| --- | --- |
| `GEMINI_API_KEY` | 你的 Gemini API Key |
| `DAILY_LIMIT` | `200`（每位使用者每天最多呼叫 AI 幾次，可依預算調整） |

## 4. 設定登入方式

### Email 驗證碼

1. **Authentication → Sign In / Providers → Email**：確認已啟用。
2. **Authentication → Emails → Templates → Magic Link**，把內容改成同時有驗證碼與連結，例如：

   ```html
   <h2>即時課堂轉錄 登入驗證碼</h2>
   <p>你的驗證碼：<strong>{{ .Token }}</strong></p>
   <p>或直接點這個連結登入：<a href="{{ .ConfirmationURL }}">登入</a></p>
   ```

> 注意：Supabase 內建的寄信服務每小時只能寄很少封，只適合測試。正式開放給同學使用前，要在 **Authentication → Emails → SMTP Settings** 接上自己的寄信服務（例如 Resend、Brevo）。

### Google 登入

1. 到 <https://console.cloud.google.com> 建立專案。
2. **APIs & Services → OAuth consent screen**：選 External，填 App 名稱與聯絡信箱。
3. **APIs & Services → Credentials → Create credentials → OAuth client ID**：
   - Application type：**Web application**
   - Authorized redirect URIs：`https://<你的專案代號>.supabase.co/auth/v1/callback`
     （在 Supabase 的 Authentication → Sign In / Providers → Google 頁面可以直接複製這個網址）
4. 把產生的 **Client ID** 與 **Client Secret** 貼到 Supabase 的 **Google** 設定並啟用。

## 5. 設定允許的網址

**Authentication → URL Configuration**：

- Site URL：`https://kuanwei0104.github.io/lecture-transcriber/`
- Redirect URLs 新增：
  - `https://kuanwei0104.github.io/lecture-transcriber/`
  - `http://localhost:8765/`（本機測試用）

## 6. 把專案資訊填進網站

**Project Settings → API** 複製兩個值，填進 `config.js`：

```js
export const SUPABASE_URL = "https://xxxxxxxx.supabase.co";
export const SUPABASE_ANON_KEY = "eyJhbGciOi...";   // anon public key
```

- **anon public key 可以公開**，資料由資料庫權限（RLS）保護，每個人只看得到自己的課程。
- **絕對不要**把 `service_role` key 放進網站或傳給任何人。

推上 GitHub 後，網站右上角會出現「👤 登入」。

## 免費方案的限制

- 專案超過 7 天沒有任何使用會被暫停，回到後台按 Restore 即可恢復。
- 資料庫 500 MB、檔案儲存 1 GB：音檔約每小時 15 MB，大約可存 60 小時課程。
- Gemini 費用由 `GEMINI_API_KEY` 的帳號支付；免費額度用完時，使用者會看到「額度已用完」的提示。
