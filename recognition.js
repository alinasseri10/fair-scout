/* Local originals, recognition jobs and review drafts. Provider secrets never enter this file. */
(function() {
  'use strict';
  const schema=FairScoutSchema;
  const labels={company:'Company (English)',companyChinese:'Company (Chinese)',brand:'Brand',booth:'Booth number',contact:'Contact name',jobTitle:'Job title',phone:'Phone',whatsapp:'WhatsApp',wechatId:'WeChat ID',email:'Email',website:'Website',address:'Address',category:'Main garment category',productType:'Product type',material:'Material composition',gsm:'GSM',sizes:'Sizes',moq:'MOQ',unitPrice:'Unit price',currency:'Currency (ISO)',priceUnit:'Price unit',quotation:'Quotation / conditions'};
  let photoIds={booth:[],card:[],product:[]}, products=[], jobs=[], running=false, initialized=false;
  let config=null, reviewJob=null, reviewURLs=[], queueBlocked=false;
  const element=(tag,text,className)=>{const el=document.createElement(tag);if(text!=null)el.textContent=text;if(className)el.className=className;return el;};
  const button=(text,action)=>{const el=element('button',text,'secondary');el.type='button';el.onclick=action;return el;};
  const tx=(stores,mode,work)=>FairScoutReliability.transaction(db,stores,mode,work);
  async function get(store,id) {let result;await tx([store],'readonly',t=>{const r=t.objectStore(store).get(id);r.onsuccess=()=>result=r.result;});return result;}
  async function all(store) {let result;await tx([store],'readonly',t=>{const r=t.objectStore(store).getAll();r.onsuccess=()=>result=r.result;});return result;}
  const owner=()=>editId||draftId;
  const idsCopy=()=>Object.fromEntries(Object.entries(photoIds).map(([type,ids])=>[type,[...ids]]));
  function snapshot() {return {photoIds:idsCopy(),products:structuredClone(products)};}
  function loadRow(row) {
    photoIds=Object.fromEntries(['booth','card','product'].map(type=>[type,(row.photos?.[type]||[]).map((_,i)=>row.photoIds?.[type]?.[i]||crypto.randomUUID())]));
    products=structuredClone(row.products||[]);drawProducts();if(initialized)renderJobs();
  }
  function reset() {photoIds={booth:[],card:[],product:[]};products=[];drawProducts();if(initialized)renderJobs();}
  function addFields() {
    const details=element('details');const summary=element('summary','Company and contact details');details.append(summary);
    const grid=element('div',null,'split');
    for(const key of ['companyChinese','brand','jobTitle','phone','whatsapp','wechatId','website','address']) {
      const group=element('div');const label=element('label',labels[key],'field');label.htmlFor=key;
      const input=element('input');input.id=key;input.maxLength=4000;
      if(['phone','whatsapp'].includes(key))input.type='tel';
      group.append(label,input);grid.append(group);
    }
    details.append(grid);$('email').parentElement.append(details);
    const panel=element('div',null,'panel');panel.append(element('h2','Products and quotations'));
    panel.append(element('p','Keep each product and price tier separate. You can edit these manually or add reviewed photo suggestions.','sub'));
    const list=element('div');list.id='productDetails';panel.append(list);
    panel.append(button('+ Add product / quotation',()=>{products.push({id:crypto.randomUUID(),...Object.fromEntries(schema.productKeys.map(k=>[k,'']))});drawProducts();draftDirty=true;queueDraft();}));
    $('supplierDetails').append(panel);
    const queue=element('div',null,'panel');queue.id='recognitionPanel';queue.hidden=!window.FairScoutCapture?.recognitionEnabled;queue.append(element('h2','Photo recognition'));
    const state=element('p','Connecting to local recognition backend…','note');state.id='recognitionConfig';queue.append(state);
    const listJobs=element('div');listJobs.id='recognitionJobs';queue.append(listJobs);
    queue.append(button('Check connection / resume pending',async()=>{queueBlocked=false;await connect();await processQueue();}));
    $('capture').parentElement.insertBefore(queue,$('capture'));
    const dialog=element('dialog');dialog.id='recognitionReview';dialog.style.cssText='width:min(720px,95vw);max-height:90vh;overflow:auto;border:1px solid #ddd;border-radius:16px;padding:18px';
    document.body.append(dialog);
    const style=element('style');style.textContent='.photo .original-link{display:block;font-size:11px;margin-top:3px}.photo button{min-width:27px}.review-item{border-top:1px solid #ddd;padding:12px 0}.review-item input[type=checkbox]{width:auto;margin-right:8px}dialog::backdrop{background:#0008}summary{cursor:pointer;font-weight:750;margin:14px 0}.recognition-job{border-top:1px solid #eee;padding:10px 0;overflow-wrap:anywhere}';document.head.append(style);
  }
  function drawProducts() {
    const list=$('productDetails');if(!list)return;list.replaceChildren();
    products.forEach((product,index)=>{
      const details=element('details');details.open=!product.productType;
      details.append(element('summary',product.productType||'New product / quotation'));
      const grid=element('div',null,'split');
      for(const key of schema.productKeys) {
        const label=element('label',labels[key],'field'),input=element('input');input.value=product[key]||'';input.maxLength=4000;
        input.oninput=()=>{product[key]=input.value;};label.append(input);grid.append(label);
      }
      details.append(grid,button('Remove product / quotation',()=>{if(confirm('Remove this product / quotation from the draft?')) {products.splice(index,1);drawProducts();draftDirty=true;queueDraft();}}));list.append(details);
    });
  }
  async function copyImage(original,maxEdge,quality) {
    const url=URL.createObjectURL(original);
    try {
      const image=new Image();image.src=url;await image.decode();
      const canvas=document.createElement('canvas');const ratio=Math.min(1,maxEdge/Math.max(image.naturalWidth,image.naturalHeight));
      canvas.width=Math.max(1,Math.round(image.naturalWidth*ratio));canvas.height=Math.max(1,Math.round(image.naturalHeight*ratio));
      const context=canvas.getContext('2d');context.fillStyle='#fff';context.fillRect(0,0,canvas.width,canvas.height);context.drawImage(image,0,0,canvas.width,canvas.height);
      const output=await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',quality));canvas.width=canvas.height=1;
      if(!output)throw Error('Image conversion unavailable');return output;
    } finally {URL.revokeObjectURL(url);}
  }
  async function derivatives(asset) {
    try {
      const [preview,recognition]=window.FairScoutCapture?.recognitionEnabled
        ?await Promise.all([copyImage(asset.original,600,0.8),copyImage(asset.original,3200,0.94)])
        :[await copyImage(asset.original,600,0.8),null];
      const current=await get('images',asset.id);if(!current)return;
      await tx(['images'],'readwrite',t=>t.objectStore('images').put({...current,preview,recognition,copyState:'ready'}));
    } catch(error) {
      const current=await get('images',asset.id);if(current)await tx(['images'],'readwrite',t=>t.objectStore('images').put({...current,copyState:'original-only',copyError:'Preview conversion unavailable: '+error.message+'. Original retained; compatible HEIC may be sent directly.'}));
    }
    drawPhotos();processQueue();
    if(window.FairScoutShared?.enabled)FairScoutShared.sync().catch(error=>toast(error.message));
  }
  async function capture(file,type) {
    const inferred=file.type || (/\.hei[cf]$/i.test(file.name)?'image/heic':'');
    if(!inferred.startsWith('image/'))throw Error('Choose an image file (including HEIC).');
    if(file.size>18*1024*1024)throw Error('Photo exceeds 18 MB. Original remains in your camera/files; choose a smaller photo.');
    if(!draftId)draftId=crypto.randomUUID();
    const id=crypto.randomUUID(), supplierId=owner();
    const original=file.type ? file : new Blob([file],{type:inferred});
    const asset={id,supplierId,type,original,name:file.name||'photo',createdAt:Date.now(),copyState:'pending'};
    const job={id,photoId:id,supplierId,kind:type,status:'Pending',createdAt:Date.now(),review:null,error:''};
    photos[type].push(original);photoIds[type].push(id);draftDirty=true;
    try {
      // Original, permanent association and recognition intent commit before decoding.
      await draftChain;
      await tx(['images','recognitionJobs','drafts'],'readwrite',t=>{
        t.objectStore('images').put(asset);t.objectStore('recognitionJobs').put(job);t.objectStore('drafts').put(snapshotDraft());
      });
    } catch(error) {photos[type].pop();photoIds[type].pop();throw error;}
    await reloadJobs();derivatives(asset).catch(error=>toast('Original saved; image processing failed: '+error.message));
  }
  async function migrate() {
    const rows=await all('suppliers');let draft=await get('drafts','current');
    await tx(['suppliers','drafts','images'],'readwrite',t=>{
      const migrateRow=(row,supplierId,storeName)=>{
        const ids=row.photoIds||{};
        for(const type of ['booth','card','product']) {
          ids[type]=(row.photos?.[type]||[]).map((original,index)=>{
            const id=ids[type]?.[index]||crypto.randomUUID();
            const request=t.objectStore('images').get(id);
            request.onsuccess=()=>{if(!request.result)t.objectStore('images').put({id,supplierId,type,original,name:'legacy-photo',createdAt:Date.now(),copyState:'original-only'});};return id;
          });
        }
        row.photoIds=ids;row.products??=[];t.objectStore(storeName).put(row);
      };
      rows.forEach(row=>migrateRow(row,row.id,'suppliers'));
      if(draft) {if(owner()===(draft.editId||draft.supplierId))draft.photoIds=idsCopy();migrateRow(draft,draft.editId||draft.supplierId,'drafts');}
    });
    await refresh();
  }
  async function drawPhotos() {
    // Keep synchronous creation for the existing capture workflow and tests.
    previewURLs.forEach(URL.revokeObjectURL);previewURLs=[];
    for(const type of ['booth','card','product']) {
      const list=$(type+'Preview');list.replaceChildren();
      photos[type].forEach((original,index)=>{
        const id=photoIds[type][index],item=element('div',null,'photo');
        const url=URL.createObjectURL(original);previewURLs.push(url);
        const image=element('img');image.src=url;image.alt=type+' photo';image.dataset.photoId=id||'';
        const link=element('a','Open / download original','original-link');link.href=url;link.download=`${type}-${id||index}.${original.type.includes('hei')?'heic':original.type.split('/')[1]||'image'}`;link.title='Download exact original file';
        const remove=element('button','×');remove.title='Remove photo';remove.onclick=()=>{
          if(!confirm('Remove this photo from the current entry? Its saved original remains in the local photo archive and backup.'))return;
          photos[type].splice(index,1);photoIds[type].splice(index,1);draftDirty=true;queueDraft();drawPhotos();
        };
        const recognize=button('Recognize',async()=>{
          if(!id)return;
          const existing=await get('recognitionJobs',id);
          if(existing?.status==='Completed') {await openReview(id);return;}
          const job=existing||{id,photoId:id,supplierId:owner(),kind:type,createdAt:Date.now()};
          job.status='Pending';job.error='';
          await tx(['recognitionJobs'],'readwrite',t=>t.objectStore('recognitionJobs').put(job));queueBlocked=false;await reloadJobs();await connect();processQueue();
        });recognize.style.cssText='position:static;width:100%;height:auto;border-radius:7px;font-size:11px;padding:6px;margin-top:4px';
        item.append(image,remove,link);if(window.FairScoutCapture?.recognitionEnabled)item.append(recognize);list.append(item);
        if(id)get('images',id).then(asset=>{
          if(asset?.preview && image.isConnected) {const preview=URL.createObjectURL(asset.preview);previewURLs.push(preview);image.src=preview;}
          else if(asset?.copyError && image.isConnected) image.alt='Original saved; preview unavailable (use original download)';
        }).catch(()=>{});
      });
    }
  }
  async function connect() {
    if(!window.FairScoutCapture?.recognitionEnabled){$('recognitionConfig').textContent='Fast capture — photo recognition is disabled. Originals stay on this device.';return false;}
    if(!navigator.onLine) {$('recognitionConfig').textContent='Offline — originals and recognition jobs stay on this device.';return false;}
    try {
      const response=await fetch('/api/status',{cache:'no-store',signal:AbortSignal.timeout(2500)});
      if(!response.ok)throw Error('Backend unavailable');config=await response.json();
      $('recognitionConfig').textContent=config.provider==='mock'?'DEMO MODE — fixed fictional results, not real photo recognition.':config.configured?`Qwen recognition ready · ${config.remaining} requests remaining`:'Recognition not configured. Originals are saved; jobs remain Pending. Set up the server or use mock mode.';
      return !!config.configured;
    } catch(_) {$('recognitionConfig').textContent='Recognition backend unavailable. Jobs remain Pending; use Check connection to resume.';config=null;return false;}
  }
  async function reloadJobs() {jobs=await all('recognitionJobs');renderJobs();}
  function renderJobs() {
    const list=$('recognitionJobs');list.replaceChildren();
    const visible=jobs.filter(job=>job.status!=='Completed'||!job.review?.applied);
    if(!visible.length)list.append(element('p','Attach a booth, card or product photo to start. Results are always reviewed before applying.','note'));
    let more;
    if(visible.length>3){more=element('details');more.append(element('summary',`Show ${visible.length-3} more recognition jobs`));}
    visible.sort((a,b)=>Number(b.supplierId===owner())-Number(a.supplierId===owner())||b.createdAt-a.createdAt).forEach((job,index)=>{
      const item=element('div',null,'recognition-job');item.append(element('strong',`${job.kind} · ${job.status}${job.mock?' · DEMO':''}`));
      const associated=loaded.find(row=>row.id===job.supplierId);
      item.append(element('p',`${associated?.company || (owner()===job.supplierId?'Current draft':'Retained draft/photo')} · ${job.photoId.slice(0,8)}`,'note'));
      if(job.error)item.append(element('p',job.error,'note'));
      const original=element('a','Download original','note');original.href='#';original.onclick=async event=>{event.preventDefault();const asset=await get('images',job.photoId);if(asset)download(asset.original,asset.name||'original-photo');};item.append(original);
      if(job.status==='Completed') item.append(button('Review suggestions',()=>openReview(job.id)));
      if(job.status==='Failed') item.append(button('Retry manually',async()=>{job.status='Pending';job.error='';await tx(['recognitionJobs'],'readwrite',t=>t.objectStore('recognitionJobs').put(job));queueBlocked=false;await reloadJobs();await connect();processQueue();}));
      (index<3?list:more).append(item);
    });
    if(more)list.append(more);
  }
  async function processQueue() {
    if(!window.FairScoutCapture?.recognitionEnabled||!initialized||running||queueBlocked||!navigator.onLine||!config?.configured)return;
    running=true;
    try {
      await reloadJobs();
      for(const job of jobs.filter(job=>job.status==='Pending')) {
        if(!navigator.onLine||queueBlocked)break;
        const asset=await get('images',job.photoId);if(!asset||asset.copyState==='pending')continue;
        // Jobs for discarded drafts are retained but never uploaded automatically.
        const currentDraft=await get('drafts','current'), saved=await get('suppliers',job.supplierId);
        const source=saved || ((currentDraft?.editId||currentDraft?.supplierId)===job.supplierId?currentDraft:null);
        if(!source||!Object.values(source.photoIds||{}).flat().includes(job.photoId))continue;
        job.status='Processing';job.error='';await tx(['recognitionJobs'],'readwrite',t=>t.objectStore('recognitionJobs').put(job));renderJobs();
        try {
          const image=$('keepOriginals').checked && owner()===job.supplierId?asset.original:(asset.recognition||asset.original);
          const encoded=await toBase64(image);
          const response=await fetch('/api/recognize',{method:'POST',headers:{'Content-Type':'application/json','X-Fair-Scout-Token':config.token},body:JSON.stringify({id:job.id,kind:job.kind,mime:image.type,image:encoded.split(',')[1]}),signal:AbortSignal.timeout(50000)});
          const output=await response.json();
          if(!response.ok) {if(response.status===503){job.status='Pending';queueBlocked=true;job.error=output.error;continue;}throw Error(output.error||'Recognition request failed');}
          job.result=schema.validateResult(output.result);job.mock=!!output.mock;job.status='Completed';job.completedAt=Date.now();job.review=null;
        } catch(error) {
          job.status=navigator.onLine?'Failed':'Pending';job.error=error.message+'. Original photo is saved.';
          // Fail fast: stop the queue after an error. No repeated network/paid retries.
          queueBlocked=true;
        } finally {await tx(['recognitionJobs'],'readwrite',t=>t.objectStore('recognitionJobs').put(job));await reloadJobs();}
      }
    } catch(error) {
      queueBlocked=true;
      $('recognitionConfig').textContent='Recognition storage error. Originals remain saved; keep this page open and export a backup.';
      toast('Recognition result could not be saved: '+error.message);
    } finally {running=false;}
  }
  async function saveReview() {
    if(!reviewJob)return;
    await tx(['recognitionJobs'],'readwrite',t=>t.objectStore('recognitionJobs').put(reviewJob));
  }
  const openReview=FairScoutReliability.singleFlight(async function(id) {
    if(busy||pendingPhotos)return;
    reviewJob=await get('recognitionJobs',id);if(!reviewJob?.result)return;
    const dialog=$('recognitionReview');dialog.replaceChildren();reviewURLs.forEach(URL.revokeObjectURL);reviewURLs=[];
    dialog.append(element('h2',reviewJob.mock?'Review DEMO suggestions':'Review photo suggestions'));
    dialog.append(element('p','Only checked values will be applied. Existing values are protected; replacement requires a separate confirmation.','note'));
    const asset=await get('images',reviewJob.photoId);
    if(asset) {
      const url=URL.createObjectURL(asset.preview||asset.original);reviewURLs.push(url);
      const image=element('img');image.src=url;image.alt='Source photo';image.style.cssText='width:100%;max-height:260px;object-fit:contain';dialog.append(image);
      const originalURL=URL.createObjectURL(asset.original);reviewURLs.push(originalURL);const link=element('a','Download original');link.href=originalURL;link.download=asset.name;dialog.append(link);
    }
    const saved=await get('suppliers',reviewJob.supplierId);
    const active=owner()===reviewJob.supplierId;
    const current=active?Object.fromEntries(fields.map(key=>[key,$(key).value])):saved||{};
    reviewJob.review??={values:structuredClone(reviewJob.result.supplier),products:structuredClone(reviewJob.result.products),selected:[],includeProducts:false,applied:false};
    const review=reviewJob.review;
    for(const warning of reviewJob.result.warnings)dialog.append(element('p','⚠ '+warning,'note'));
    for(const key of schema.supplierKeys) {
      if(review.values[key]==null)continue;
      const block=element('div',null,'review-item'),label=element('label',labels[key],'field'),check=element('input');check.type='checkbox';check.checked=review.selected.includes(key);check.dataset.reviewSelect=key;
      check.onchange=async()=>{review.selected=check.checked?[...new Set([...review.selected,key])]:review.selected.filter(k=>k!==key);await saveReview();};
      label.prepend(check);const input=element('input');input.value=review.values[key];input.dataset.reviewField=key;input.maxLength=4000;
      input.oninput=()=>{review.values[key]=input.value;saveReview().catch(()=>toast('Review draft could not be saved'));};
      block.append(label,input,element('p','Current: '+(current[key]||'(empty)')+(current[key] && current[key]!==review.values[key]?' · CONFLICT — protected':''),'note'));
      const evidence=reviewJob.result.evidence.find(e=>e.field===key);if(evidence)block.append(element('p',`${evidence.uncertain?'⚠ Unclear / visual suggestion: ':'Source: '}${evidence.text}`,'note'));
      dialog.append(block);
    }
    if(review.products.length) {
      const label=element('label',' Add these products / quotation tiers as separate entries','field'),check=element('input');check.type='checkbox';check.style.width='auto';check.checked=review.includeProducts;check.id='reviewIncludeProducts';check.onchange=()=>{review.includeProducts=check.checked;saveReview();};label.prepend(check);dialog.append(label);
      review.products.forEach((product,index)=>{
        const details=element('details');details.open=true;details.append(element('summary',`Product / price tier ${index+1}`));
        for(const key of schema.productKeys) {const label=element('label',labels[key],'field'),input=element('input');input.value=product[key]||'';input.dataset.reviewProduct=`${index}.${key}`;input.maxLength=4000;input.oninput=()=>{product[key]=input.value;saveReview();};label.append(input);details.append(label);}
        dialog.append(details);
      });
    }
    const status=element('p','Review edits save automatically on this device.','note');status.id='reviewStatus';dialog.append(status);
    const actions=element('div',null,'actions');actions.append(button('Apply selected values',applyReview),button('Close review',async()=>{await saveReview();dialog.close();}));dialog.append(actions);
    dialog.oncancel=()=>saveReview().catch(()=>{});
    await saveReview();if(!dialog.open)dialog.showModal();
  });
  const applyReview=FairScoutReliability.singleFlight(async function() {
    if(!reviewJob||busy)return;
    const job=reviewJob,review=job.review;
    if(review.applied){$('reviewStatus').textContent='These suggestions were already applied. Edit the supplier form for further changes.';return;}
    const active=owner()===job.supplierId;
    if(!active && !await get('suppliers',job.supplierId)) {$('reviewStatus').textContent='This draft is no longer active. Its photo is retained, but suggestions cannot be applied to a different supplier.';return;}
    const saved=await get('suppliers',job.supplierId);
    const current=active?Object.fromEntries(fields.map(key=>[key,$(key).value])):saved;
    const changes=Object.fromEntries(review.selected.map(key=>[key,String(review.values[key]??'').trim()]));
    if(changes.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(changes.email)) {$('reviewStatus').textContent='Correct the email before applying.';return;}
    if(changes.category && !schema.categories.includes(changes.category)) {$('reviewStatus').textContent='Use an existing garment category.';return;}
    const conflicts=Object.keys(changes).filter(key=>current[key] && current[key]!==changes[key]);
    if(conflicts.length && !confirm('Replace confirmed values for: '+conflicts.map(key=>labels[key]).join(', ')+'? Your existing values will change.'))return;
    const additions=review.includeProducts?review.products.map(product=>({id:crypto.randomUUID(),sourcePhotoId:job.photoId,...Object.fromEntries(schema.productKeys.map(key=>[key,product[key]||'']))})):[];
    if(!Object.keys(changes).length && !additions.length){$('reviewStatus').textContent='Select at least one value or product.';return;}
    setBusy(true);
    try {
      await draftChain;
      if(!active&&window.FairScoutShared?.enabled){
        await FairScoutShared.save({...saved,...changes,products:[...(saved.products||[]),...additions],updatedAt:Date.now()},{baseRevision:saved._cloud?.revision??0,removeDraft:false,reviewJob:{...job,review:{...review,applied:true}}});
      }else await tx(['suppliers','drafts','recognitionJobs'],'readwrite',t=>{
        const store=t.objectStore(active?'drafts':'suppliers');
        const row=active?snapshotDraft():{...saved};
        if(active)Object.assign(row.values,changes);else Object.assign(row,changes);
        row.products=[...(row.products||[]),...additions];
        if(active) {row.dirty=true;row.savedAt=Date.now();}else row.updatedAt=Date.now();
        if(active||!window.FairScoutShared?.enabled)store.put(row);
        job.review={...review,applied:true};t.objectStore('recognitionJobs').put(job);
      });
      if(active) {for(const [key,value] of Object.entries(changes))$(key).value=value;products.push(...additions);draftDirty=true;drawProducts();$('draftState').textContent='Reviewed draft saved on device';}
      await refresh();await reloadJobs();$('recognitionReview').close();toast('Selected information applied and saved');
    } catch(error) {$('reviewStatus').textContent='Could not apply: '+error.message;}
    finally {setBusy(false);if(window.FairScoutShared?.enabled)FairScoutShared.sync().catch(error=>toast(error.message));}
  });
  function validateBackupExtras(backup,rows) {
    const extra=backup.recognition;if(!extra)return null;
    if(extra.version!==1||!Array.isArray(extra.images)||!Array.isArray(extra.jobs))throw Error('Invalid recognition backup');
    const ids=new Set(),images=extra.images.map(image=>{
      if(!image||typeof image.id!=='string'||!/^[\w-]{1,100}$/.test(image.id)||ids.has(image.id)||!['booth','card','product'].includes(image.type)||typeof image.supplierId!=='string'||!image.supplierId||image.supplierId.length>200)throw Error('Invalid photo archive');
      ids.add(image.id);
      return {id:image.id,supplierId:image.supplierId,type:image.type,name:String(image.name||'photo').slice(0,200),original:FairScoutReliability.decodePhoto(image.original),preview:image.preview?FairScoutReliability.decodePhoto(image.preview):null,recognition:image.recognition?FairScoutReliability.decodePhoto(image.recognition):null,copyState:image.recognition?'ready':'original-only',createdAt:Number(image.createdAt)||Date.now()};
    });
    const jobIds=new Set();const restoredJobs=extra.jobs.map(job=>{
      if(!job||typeof job.id!=='string'||jobIds.has(job.id)||!ids.has(job.photoId)||!['booth','card','product'].includes(job.kind)||!['Pending','Processing','Completed','Failed'].includes(job.status)||typeof job.supplierId!=='string')throw Error('Invalid recognition job');
      jobIds.add(job.id);const result=job.result?schema.validateResult(job.result):null;
      const image=images.find(image=>image.id===job.photoId);
      if(job.id!==job.photoId||image.supplierId!==job.supplierId||image.type!==job.kind)throw Error('Recognition photo association mismatch');
      if(job.status==='Completed'&&!result)throw Error('Completed job missing results');
      let review=null;
      if(job.review) {
        if(!result||!Array.isArray(job.review.selected)||job.review.selected.some(k=>!schema.supplierKeys.includes(k)))throw Error('Invalid review draft');
        review={values:Object.fromEntries(schema.supplierKeys.map(key=>{const value=job.review.values?.[key]??null;if(value!==null&&typeof value!=='string')throw Error('Invalid review value');return [key,value];})),products:FairScoutReliability.validateProducts(job.review.products||[]).map(p=>Object.fromEntries(schema.productKeys.map(k=>[k,p[k]||null]))),selected:job.review.selected,includeProducts:!!job.review.includeProducts,applied:!!job.review.applied};
      }
      return {id:job.id,photoId:job.photoId,supplierId:job.supplierId,kind:job.kind,status:job.status==='Processing'?'Failed':job.status,result,review,mock:!!job.mock,error:job.status==='Processing'?'Interrupted request; retry manually.':String(job.error||'').slice(0,1000),createdAt:Number(job.createdAt)||Date.now()};
    });
    let draft=null;
    if(extra.draft) {
      const source=extra.draft;
      const restored=FairScoutReliability.validateBackup({format:'tt-fair-scout-v1',suppliers:[{id:source.supplierId||source.editId,createdAt:source.savedAt,updatedAt:source.savedAt,...source.values,photos:source.photos,photoIds:source.photoIds,products:source.products}]})[0];
      draft={id:'current',supplierId:source.supplierId,editId:source.editId||null,capturedAt:Number.isSafeInteger(source.capturedAt)&&source.capturedAt>=0?source.capturedAt:source.savedAt,savedAt:source.savedAt,dirty:!!source.dirty,values:Object.fromEntries(fields.map(key=>[key,restored[key]])),photos:restored.photos,photoIds:restored.photoIds,products:restored.products};
    }
    for(const row of [...rows,...(draft?[draft]:[])])for(const type of ['booth','card','product'])for(const id of row.photoIds?.[type]||[]){
      const image=images.find(image=>image.id===id);if(!image||image.supplierId!==(row.id==='current'?(row.editId||row.supplierId):row.id)||image.type!==type)throw Error('Backup photo association mismatch');
    }
    return {images,jobs:restoredJobs,draft};
  }
  async function restoreBackup(rows,extra) {
    const counts={added:0,updated:0,skipped:0};
    let restoredDraft=false;
    for(const image of extra.images){const current=await get('images',image.id);if(current){
      if(current.supplierId!==image.supplierId||current.type!==image.type||current.original.size!==image.original.size)throw Error('Photo ID collision; existing original protected');
      const hash=async blob=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',await blob.arrayBuffer()))).join(',');
      if(await hash(current.original)!==await hash(image.original))throw Error('Photo ID collision; existing original protected');
    }}
    await tx(['suppliers','images','recognitionJobs','drafts'],'readwrite',t=>{
      FairScoutReliability.reserveCaptureNumbers(t,rows);
      for(const row of rows){const store=t.objectStore('suppliers'),request=store.get(row.id);request.onsuccess=()=>{const existing=request.result;if(existing&&(existing.updatedAt||0)>=row.updatedAt){counts.skipped++;return;}store.put(row);counts[existing?'updated':'added']++;};}
      // IDs are immutable. Existing local image/job state is never overwritten by import.
      for(const [name,items] of [['images',extra.images],['recognitionJobs',extra.jobs]])for(const item of items){const store=t.objectStore(name),request=store.get(item.id);request.onsuccess=()=>{if(!request.result)store.put(item);};}
      if(extra.draft){const store=t.objectStore('drafts'),request=store.get('current');request.onsuccess=()=>{if(!request.result){store.put(extra.draft);restoredDraft=true;}};}
    });
    if(restoredDraft){const draft=extra.draft;fields.forEach(key=>$(key).value=draft.values[key]||'');photos=draft.photos;editId=draft.editId;draftId=draft.supplierId;draftCapturedAt=draft.capturedAt;draftDirty=draft.dirty;loadRow(draft);drawPhotos();$('draftState').textContent='Backup draft restored';}
    await migrate();await reloadJobs();return counts;
  }
  async function exportBackup() {
    if(window.FairScoutShared?.enabled){FairScoutShared.guard();for(const row of await all('suppliers'))await FairScoutShared.ensurePhotos(row);}
    await draftChain;
    const rows=await all('suppliers'),images=await all('images'),exportJobs=await all('recognitionJobs'),draft=await get('drafts','current');
    async function serializePhotos(row){const out={...row,photos:{}};for(const type of ['booth','card','product'])out.photos[type]=await Promise.all((row.photos?.[type]||[]).map(toBase64));return out;}
    const suppliers=[];for(const row of rows)suppliers.push(await serializePhotos(row));
    const archive=[];for(const image of images)archive.push({...image,original:await toBase64(image.original),preview:image.preview?await toBase64(image.preview):null,recognition:image.recognition?await toBase64(image.recognition):null});
    const backup={format:'tt-fair-scout-v1',schemaVersion:2,exportedAt:new Date().toISOString(),suppliers,recognition:{version:1,images:archive,jobs:exportJobs,draft:draft?await serializePhotos(draft):null}};
    if(window.FairScoutShared?.enabled)backup.cloudRecovery=await FairScoutShared.exportRecovery();
    download(new Blob([JSON.stringify(backup)],{type:'application/json'}),'canton-fair-backup.json');toast('Backup includes saved suppliers, originals, queue and unfinished draft');
  }
  async function init() {
    await migrate();
    for(const job of await all('recognitionJobs'))if(job.status==='Processing'){job.status='Failed';job.error='Request interrupted. Original retained; retry manually to avoid an unintended paid repeat.';await tx(['recognitionJobs'],'readwrite',t=>t.objectStore('recognitionJobs').put(job));}
    initialized=true;await reloadJobs();drawPhotos();
    for(const image of await all('images'))if(image.copyState==='pending')derivatives(image).catch(()=>{});
    $('exportJSON').onclick=FairScoutReliability.singleFlight(async()=>{try{await exportBackup();}catch(error){toast('Backup failed: '+error.message);}});
    await connect();processQueue();
    window.addEventListener('online',async()=>{queueBlocked=false;await connect();processQueue();});
    window.addEventListener('offline',()=>{$('recognitionConfig').textContent='Offline — originals and jobs remain saved.';});
  }
  addFields();
  window.recognition={init,migrate,capture,snapshot,loadRow,reset,drawPhotos,copyImage,processQueue,connect,get,all,openReview,applyReview,exportBackup,validateBackupExtras,restoreBackup};
})();
