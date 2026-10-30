/* Photo-first presentation. No network, recognition or cloud work in this file. */
(() => {
  'use strict';
  const details=$('supplierDetails');
  if(window.FAIR_SCOUT_SHOW_DETAILS===true)details.open=true;
  const enabled=window.FAIR_SCOUT_ENABLE_RECOGNITION===true;
  document.body.classList.add('fast-capture');
  document.body.classList.toggle('recognition-enabled',enabled);
  const label=row=>row.company?.trim() || (row.captureNumber?'Booth #'+String(row.captureNumber).padStart(3,'0'):'Booth · '+row.id.slice(0,8));
  function decisions(){for(const button of document.querySelectorAll('[data-decision]'))button.setAttribute('aria-pressed',String(button.dataset.decision===$('decision').value));}
  for(const button of document.querySelectorAll('[data-decision]'))button.onclick=()=>{
    $('decision').value=button.dataset.decision;decisions();$('decision').dispatchEvent(new Event('input',{bubbles:true}));
  };
  $('decision').addEventListener('change',decisions);
  const originalDraw=drawPhotos;
  drawPhotos=function(){originalDraw();decisions();};
  const originalReset=resetForm;
  resetForm=function(){originalReset();decisions();};
  let thumbnails=[],generation=0;
  function clearThumbnails(){generation++;for(const url of thumbnails)URL.revokeObjectURL(url);thumbnails=[];}
  const originalRender=renderList;
  renderList=function(){
    clearThumbnails();const current=generation;
    // Avoid rebuilding hundreds of cards while the collector is taking photos.
    if($('list').classList.contains('hidden')){$('supplierList').replaceChildren();return;}
    originalRender();
    const byId=new Map(loaded.map(row=>[row.id,row]));
    for(const card of $('supplierList').children){
      const row=byId.get(card.dataset.supplierId);if(!row)continue;
      const time=document.createElement('time');time.dateTime=new Date(row.createdAt).toISOString();time.textContent=new Date(row.createdAt).toLocaleString();time.className='note capture-time';card.append(time);
      const id=row.photoIds?.booth?.[0],original=row.photos?.booth?.[0];
      if(!id&&!original)continue;
      const image=document.createElement('img');image.className='supplier-thumbnail';image.alt='Booth sign for '+label(row);image.loading='lazy';image.width=80;image.height=80;
      card.prepend(image);
      const show=blob=>{if(!blob||current!==generation||!image.isConnected)return;const url=URL.createObjectURL(blob);thumbnails.push(url);image.src=url;};
      if(id&&window.recognition)recognition.get('images',id).then(asset=>show(asset?.preview||asset?.original||original)).catch(()=>show(original));else show(original);
    }
  };
  $('tabNew').addEventListener('click',clearThumbnails);
  async function updateNext(){
    let counter=0;
    await FairScoutReliability.transaction(db,['drafts'],'readonly',tx=>{tx.objectStore('drafts').get('captureCounter').onsuccess=e=>counter=e.target.result?.value||0;});
    $('nextBoothLabel').textContent='Next #'+String(Math.max(counter,loaded.length,...loaded.map(row=>row.captureNumber||0))+1).padStart(3,'0');
  }
  window.FairScoutCapture={recognitionEnabled:enabled,label,decisions,updateNext};
})();
