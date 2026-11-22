// Service Worker: macht das Spiel offline spielbar (nach dem ersten Laden).
// Bei jeder Änderung an den Dateien VERSION erhöhen, damit Geräte die neue Fassung laden.
const VERSION = 'roadster-escape-v7';
const CDN = 'https://cdn.jsdelivr.net/npm/three@0.160.0/';
const FILES = [
  "./",
  "index.html",
  "manifest.webmanifest",
  "css/style.css",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "js/assets.js",
  "assets/sky.hdr",
  "assets/tex/asphalt_02_diff.jpg",
  "assets/tex/asphalt_02_nor.jpg",
  "assets/tex/asphalt_02_rough.jpg",
  "assets/tex/beige_wall_001_diff.jpg",
  "assets/tex/beige_wall_001_nor.jpg",
  "assets/tex/beige_wall_001_rough.jpg",
  "assets/tex/bitumen_diff.jpg",
  "assets/tex/bitumen_nor.jpg",
  "assets/tex/bitumen_rough.jpg",
  "assets/tex/brick_wall_02_diff.jpg",
  "assets/tex/brick_wall_02_nor.jpg",
  "assets/tex/brick_wall_02_rough.jpg",
  "assets/tex/concrete_pavement_diff.jpg",
  "assets/tex/concrete_pavement_nor.jpg",
  "assets/tex/concrete_pavement_rough.jpg",
  "assets/tex/concrete_wall_008_diff.jpg",
  "assets/tex/concrete_wall_008_nor.jpg",
  "assets/tex/concrete_wall_008_rough.jpg",
  "js/audio.js",
  "js/camera.js",
  "js/config.js",
  "js/environment.js",
  "js/fx.js",
  "js/game.js",
  "js/garage.js",
  "js/hud.js",
  "js/input.js",
  "js/main.js",
  "js/menu.js",
  "js/missions.js",
  "js/police.js",
  "js/ui.js",
  "js/world/noise.js",
  "js/world/traffic.js",
  "js/world/world.js",
  "js/vehicle/carmodel.js",
  "js/weather.js",
  "js/world/street.js",
  "js/world/suburb.js",
  "js/vehicle/vehicle.js"
];
const THREE_FILES = [
  "build/three.module.min.js",
  "examples/jsm/postprocessing/EffectComposer.js",
  "examples/jsm/postprocessing/RenderPass.js",
  "examples/jsm/postprocessing/UnrealBloomPass.js",
  "examples/jsm/postprocessing/OutputPass.js",
  "examples/jsm/objects/Lensflare.js",
  "examples/jsm/postprocessing/Pass.js",
  "examples/jsm/postprocessing/ShaderPass.js",
  "examples/jsm/postprocessing/GTAOPass.js",
  "examples/jsm/shaders/GTAOShader.js",
  "examples/jsm/shaders/PoissonDenoiseShader.js",
  "examples/jsm/math/SimplexNoise.js",
  "examples/jsm/postprocessing/MaskPass.js",
  "examples/jsm/shaders/CopyShader.js",
  "examples/jsm/shaders/LuminosityHighPassShader.js",
  "examples/jsm/shaders/OutputShader.js"
].map((f) => CDN + f);

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then(async (c) => {
    await c.addAll(FILES);
    await Promise.all(THREE_FILES.map((u) => c.add(u).catch(() => {})));   // CDN optional
  }).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

// Erst Cache, sonst Netz (und das Ergebnis für später merken)
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request).then((res) => {
    if (res.ok && (e.request.url.startsWith(self.location.origin) || e.request.url.startsWith(CDN))) {
      const copy = res.clone(); caches.open(VERSION).then((c) => c.put(e.request, copy));
    }
    return res;
  })));
});
