// Bump this version whenever ANY shell asset changes. IndexedDB is independent.
const CACHE='fair-scout-shell-v10';
const BASE=new URL('./',self.location.href||self.location.origin+'/').pathname;
const PREFIX=BASE==='/'?'fair-scout-shell-':'fair-scout-shell@'+encodeURIComponent(BASE)+'-';
const CACHE_NAME=BASE==='/'?CACHE:PREFIX+CACHE.slice('fair-scout-shell-'.length);
const FILES=['','index.html','app.js','fast-capture.js','reliability.js','reliability-ui.js','recognition-schema.js','recognition.js','cloud-config.js','cloud-core.js','cloud-store.js','cloud-adapter.js','cloud-ui.js','pwa.js','mobile.css','manifest.webmanifest','icons/icon-192.png','icons/icon-512.png','icons/apple-touch-icon.png'];
const SHELL=FILES.map(file=>BASE+file);
// addAll is atomic: failed downloads must not activate a partial release.
// No skipWaiting: current windows retain their release until all windows close.
self.addEventListener('install',event=>event.waitUntil(caches.open(CACHE_NAME).then(cache=>cache.addAll(SHELL.map(url=>new Request(url,{cache:'reload'}))))));
self.addEventListener('activate',event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key.startsWith(PREFIX)&&key!==CACHE_NAME).map(key=>caches.delete(key)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',event=>{
  const url=new URL(event.request.url);
  if(event.request.method!=='GET'||url.origin!==self.location.origin||!SHELL.includes(url.pathname))return;
  // Serve one coherent release. Never return HTML in place of a missing script.
  event.respondWith(caches.open(CACHE_NAME).then(async cache=>(await cache.match(url.pathname))||fetch(event.request)));
});
