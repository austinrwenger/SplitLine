const CACHE = 'splitline-v1';
const FILES = ['./', './index.html', './style.css', './app.mjs', './core.mjs', './backend.mjs', './firebase-config.mjs', './icon.svg', './manifest.webmanifest'];
self.addEventListener('install', event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(FILES))));
self.addEventListener('activate', event => event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('splitline-') && key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim())));
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET' || new URL(event.request.url).origin !== self.location.origin || !new URL(event.request.url).pathname.startsWith(new URL(self.registration.scope).pathname)) return;
  // Versioned, cache-first shell: a single race never mixes incompatible releases.
  event.respondWith(caches.match(event.request, { ignoreSearch: true }).then(cached => cached || fetch(event.request)));
});
