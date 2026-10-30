'use strict';
(() => {
  const network=document.getElementById('networkStatus');
  const offline=document.getElementById('offlineStatus');
  const update=document.getElementById('updateStatus');
  function connection(){
    network.dataset.offline=String(!navigator.onLine);
    network.textContent=navigator.onLine?'Online · saved on this device':'Offline · photos and drafts stay on this device';
  }
  connection();
  window.addEventListener('online',connection);window.addEventListener('offline',connection);
  document.getElementById('installHelp').hidden=!!(matchMedia('(display-mode: standalone)').matches || navigator.standalone);
  if(!window.isSecureContext || !('serviceWorker' in navigator)){
    offline.textContent='Offline reopening unavailable · use HTTPS in Safari';return;
  }
  function status(registration,installedWorker){
    // Some engines dispatch statechange before registration.waiting is populated.
    const waiting=!!(registration.active&&(registration.waiting||(installedWorker?.state==='installed'&&installedWorker!==registration.active)));
    update.hidden=!waiting;
    update.textContent=waiting?'Update ready · wait for Draft saved, then close all Fair Scout windows and reopen':'';
    if(registration.active)offline.textContent='Ready to reopen offline';
  }
  const appRoot=new URL('./',document.baseURI);
  navigator.serviceWorker.register(new URL('sw.js',appRoot),{scope:appRoot.pathname,updateViaCache:'none'}).then(registration=>{
    status(registration);
    registration.addEventListener('updatefound',()=>{
      const worker=registration.installing;
      worker?.addEventListener('statechange',()=>{
        if(worker.state==='installed')status(registration,worker);
        if(worker.state==='redundant'&&!registration.active)offline.textContent='Offline setup failed · reconnect and reopen';
      });
    });
    navigator.serviceWorker.ready.then(()=>status(registration));
  }).catch(()=>{offline.textContent='Offline setup unavailable · reconnect and reopen';});
})();
