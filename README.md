# 即時課堂轉錄（網頁版）

在任何裝置的瀏覽器上使用：iPhone / iPad、Mac、Windows。

- **即時逐字稿**：瀏覽器內建語音辨識（即時），或 Gemini 音訊辨識（較穩定、延遲約 5–15 秒）
- **翻譯**：每 20 秒批次翻譯（中 ↔ 英）
- **精修順稿**：每隔數分鐘由 Gemini 整理成章節式順稿（依上課語言產生中文或英文）
- **圖解**：Gemini 產生結構、瀏覽器繪製 SVG 講義圖
- **課後提問**：按停止錄音後，依整堂內容產生可問講者或與同學討論的問題（依上課語言產生中文或英文問題；題數可在設定調整，可複製、重新產生）
- **課程心智圖**：匯出的檔案最上方有一張整堂課的心智圖（中文版為中文、English 版為英文）
- **匯出 HTML**：可分別下載中文版與 English 版（英文版由 Gemini 翻譯），含順稿、圖解、課後提問與原始逐字稿
- 內容自動存在本機瀏覽器，重新整理不會遺失

## 使用方式

1. 打開網址，第一次會跳出設定，貼上 Gemini API Key（到 <https://aistudio.google.com/apikey> 免費申請）。
   Key 只存在該裝置的瀏覽器中，不會上傳到任何其他地方。
2. 按「▶ 開始錄音」，允許使用麥克風。

### 各裝置建議

| 裝置 | 建議瀏覽器 | 語音辨識方式 |
|---|---|---|
| Windows | Chrome / Edge | 瀏覽器即時辨識 |
| Mac | Chrome / Safari | 瀏覽器即時辨識 |
| iPhone / iPad | Safari | 瀏覽器即時辨識；若常中斷改用「Gemini 音訊辨識」 |
| Firefox | — | 只能用「Gemini 音訊辨識」 |

iPhone / iPad 注意事項：
- 需開啟「設定 › 一般 › 鍵盤 › 啟用聽寫」。
- 上課時保持此頁在前景、螢幕不要鎖定（鎖定後 iOS 會暫停收音）。
- 可用 Safari 的「分享 › 加入主畫面」當成 App 使用。

## 部署（GitHub Pages）

純靜態網站，沒有建置步驟。推到 GitHub 後在 repo 的 **Settings › Pages** 選擇
`Deploy from a branch` → `main` / `(root)` 即可。

本機測試：

```bash
python -m http.server 8765
```

然後開啟 <http://localhost:8765>。
