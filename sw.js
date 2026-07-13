/* No memes — 仅缓存本站静态资源，绝不代理 cn.fflogs.com（省点数 + 避免脏数据） */
"use strict";

const CACHE = "no-memes-static-v1";
const PRECACHE = [
  "./",
  "./index.html",
  "./app.js",
  "./style.css",
  "./manifest.webmanifest",
  "./favicon.ico",
  "./fonts/lxgwwenkaiscreen.css",
  "./icons/app-icon-192.png",
  "./icons/app-icon-512.png",
  "./icons/favicon.png",
  "./icons/apple-touch-icon.png",
];

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(PRECACHE.map(u => new Request(u, { cache: "reload" }))))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting())
  );
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", event => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  // 跨域（FF Logs API / OAuth）一律不碰
  if (url.origin !== self.location.origin) return;

  event.respondWith((async () => {
    const cached = await caches.match(req);
    if (cached) {
      // 后台刷新 html/js/css，下次打开拿新版；字体/图标可长期用缓存
      const path = url.pathname;
      if (/\.(html|js|css|webmanifest)$/.test(path) || path.endsWith("/")) {
        event.waitUntil(refresh(req));
      }
      return cached;
    }
    try {
      const res = await fetch(req);
      if (res.ok && shouldCache(url)) {
        const clone = res.clone();
        caches.open(CACHE).then(c => c.put(req, clone)).catch(() => {});
      }
      return res;
    } catch {
      if (req.mode === "navigate") {
        const shell = await caches.match("./index.html");
        if (shell) return shell;
      }
      throw new Error("offline");
    }
  })());
});

function shouldCache(url) {
  return /\.(css|js|png|woff2|ico|webmanifest|html|svg)$/i.test(url.pathname)
    || url.pathname.endsWith("/")
    || /\/icons\//.test(url.pathname)
    || /\/fonts\//.test(url.pathname);
}

async function refresh(req) {
  try {
    const res = await fetch(req, { cache: "no-cache" });
    if (res.ok) {
      const c = await caches.open(CACHE);
      await c.put(req, res);
    }
  } catch { /* 离线时忽略 */ }
}
