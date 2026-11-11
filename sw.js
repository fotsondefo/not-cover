// Service worker Not Cover : shell en cache, réseau d'abord pour le code (mises à jour rapides)
const VERSION = "notcover-v2";
const SHELL = [
  "./", "./index.html", "./css/style.css",
  "./js/app.js", "./js/store.js", "./js/words.js", "./js/firebase-config.js", "./js/local-db-worker.js",
  "./manifest.webmanifest", "./icons/icon.svg", "./icons/icon-192.png", "./icons/icon-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  // Ne jamais intercepter le temps réel / l'auth Firebase
  if (/firebaseio\.com|firebasedatabase\.app|googleapis\.com\/identitytoolkit|securetoken/.test(url.href)) return;

  // SDK Firebase + polices : cache d'abord
  if (url.hostname === "www.gstatic.com" || url.hostname.includes("fonts.")) {
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); return res;
    })));
    return;
  }

  // Fichiers de l'app : réseau d'abord, cache en secours (hors-ligne)
  if (url.origin === location.origin) {
    e.respondWith(
      fetch(req).then((res) => {
        const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); return res;
      }).catch(() => caches.match(req, { ignoreSearch: true }).then((hit) => hit || caches.match("./index.html")))
    );
  }
});
