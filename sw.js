// 離線快取：網路優先，失敗才用快取（確保更新後能立即拿到新版）
const CACHE = "lecture-v5";
const ASSETS = ["./", "index.html", "style.css", "app.js", "util.js", "gemini.js", "diagram.js",
                "recognizers.js", "manifest.webmanifest", "icons/icon-192.png", "icons/icon-180.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;   // Gemini API 不經過快取
  e.respondWith(
    // cache: "no-cache" 讓瀏覽器每次向伺服器確認（ETag），更新後立即生效
    fetch(e.request.url, { cache: "no-cache", credentials: "same-origin" })
      .then((res) => {
        if (!res.ok) return caches.match(e.request, { ignoreSearch: true }).then((c) => c || res);
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});
