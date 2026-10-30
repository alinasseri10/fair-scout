'use strict';
const reliability = FairScoutReliability;
let draftDirty = false, draftId = null, draftChain = Promise.resolve(), draftError = null;
let busy = false, photoChain = Promise.resolve(), pendingPhotos = 0, ready = false;
let draftWrites = 0, editRevision = 0, draftCapturedAt = null;
const captureControls = () => [...$('capture').querySelectorAll('input,textarea,select,button')];
function setBusy(value) {
  busy = value;
  value = value || !!window.FairScoutShared?.locked;
  captureControls().forEach(control => control.disabled = value || !ready);
  $('restore').disabled = value || !ready;
  $('tabList').disabled = value || !ready;
  $('tabNew').disabled = value || !ready;
}
function snapshotDraft() {
  const values = Object.fromEntries(fields.map(field => [field, $(field).value]));
  return {id:'current', supplierId:draftId, editId, values,
    capturedAt:draftCapturedAt??=Date.now(),
    photos:{booth:[...photos.booth], card:[...photos.card], product:[...photos.product]},
    ...(window.recognition ? recognition.snapshot() : {}),
    cloudBaseRevision:editRevision, dirty:draftDirty, keepOriginals:$('keepOriginals').checked, savedAt:Date.now()};
}
function hasDraftContent() {
  return fields.some(field => !['factory','decision'].includes(field) && $(field).value.trim()) ||
    $('factory').value !== 'Not verified' || $('decision').value !== 'Maybe' ||
    Object.values(photos).some(items => items.length);
}
function queueDraft() {
  if (!ready || window.FairScoutShared?.locked) return draftChain;
  if (!draftId) draftId = crypto.randomUUID();
  const draft = snapshotDraft(), hasContent = hasDraftContent();
  draftWrites++;
  $('draftState').textContent = 'Saving draft…';
  draftChain = draftChain.catch(() => {}).then(() => reliability.transaction(db, ['drafts'], 'readwrite', tx => {
    const drafts = tx.objectStore('drafts');
    if (hasContent) drafts.put(draft); else drafts.delete('current');
  })).then(() => {
    draftError = null;
    if (draftWrites === 1) $('draftState').textContent = hasContent ? 'Draft saved on device' : 'Ready';
  }).catch(error => {
    draftError = error;
    $('draftState').textContent = 'Draft NOT saved — keep this page open';
    toast('Draft could not be saved. Back up records and free device storage.');
  }).finally(() => { draftWrites--; });
  return draftChain;
}
async function allowDraftReplacement() {
  if (busy || pendingPhotos || !ready) { toast('Please wait for the current operation.'); return false; }
  await draftChain;
  return !(draftDirty || draftError) || confirm('Replace your unfinished supplier draft? Its unsaved changes and attached photos will be discarded.');
}
const originalResetForm = resetForm;
resetForm = function () {
  originalResetForm();
  draftDirty = false;
  draftId = null; editRevision=0; draftCapturedAt=null;
};
$('capture').addEventListener('input', event => {
  if (!ready || busy || event.target.type === 'file') return;
  draftDirty = true;
  queueDraft();
});
$('capture').addEventListener('click', event => {
  if (event.target.closest('.photo button')) { draftDirty = true; queueDraft(); }
});
$('reset').onclick = reliability.singleFlight(async () => {
  if (!await allowDraftReplacement()) return;
  setBusy(true);
  try {
    await reliability.transaction(db,['drafts'],'readwrite',tx => tx.objectStore('drafts').delete('current'));
    resetForm();
  } catch (error) { toast('Could not clear draft: '+error.message); }
  finally { setBusy(false); }
});
window.addEventListener('beforeunload', event => {
  if (pendingPhotos || busy || draftError || draftWrites > 0) {
    event.preventDefault(); event.returnValue = '';
  }
});

async function deleteSupplier(row) {
  if (busy || pendingPhotos || !ready) { toast('Please wait for the current operation.'); return; }
  const deletesDraft = editId === row.id;
  if (!confirm(deletesDraft ? 'Delete this supplier, all its photos, and the draft you are editing? This cannot be undone.' : 'Delete this supplier and all its photos? This cannot be undone.')) return;
  setBusy(true);
  try {
    await draftChain;
    if(window.FairScoutShared?.enabled)await FairScoutShared.remove(row);
    else await reliability.transaction(db,['suppliers','drafts'],'readwrite',tx => {
      tx.objectStore('suppliers').delete(row.id);
      if (deletesDraft) tx.objectStore('drafts').delete('current');
    });
    if (deletesDraft) resetForm();
    await refresh(); await updateStorage(); toast('Supplier deleted');
  } catch (error) { toast('Delete failed: '+error.message); }
  finally { setBusy(false); if(window.FairScoutShared?.enabled)FairScoutShared.sync().catch(error=>toast(error.message)); }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && ready && !busy) queueDraft();
  if (document.visibilityState === 'visible' && ready) updateStorage();
});

async function optimizePhoto(file) {
  if (!file.type.startsWith('image/')) throw new Error('Choose an image file.');
  if (file.size > 18*1024*1024) throw new Error('Photo too large. Maximum original size is 18 MB.');
  // Preserve small files, explicit originals, and formats the browser cannot decode.
  if ($('keepOriginals').checked || file.size <= 600*1024) return file;
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const scale = Math.min(1, 3200 / Math.max(image.naturalWidth,image.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.naturalWidth*scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight*scale));
    const context = canvas.getContext('2d');
    context.fillStyle = '#fff'; context.fillRect(0,0,canvas.width,canvas.height);
    context.drawImage(image,0,0,canvas.width,canvas.height);
    const compressed = await new Promise(resolve => canvas.toBlob(resolve,'image/jpeg',0.92));
    canvas.width = canvas.height = 1;
    return compressed && compressed.size < file.size*0.9 ? compressed : file;
  } catch (_) { return file; }
  finally { URL.revokeObjectURL(url); }
}
for (const [input,type] of [['boothPhoto','booth'],['cardPhoto','card'],['productPhoto','product'],['garmentCamera','product']]) {
  $(input).onchange = event => {
    const files = [...event.target.files]; event.target.value = '';
    if(!files.length)return;
    pendingPhotos++;
    $('save').disabled = true;
    photoChain = photoChain.catch(()=>{}).then(async () => {
      for (const file of files) {
        try {
          if(window.recognition) await recognition.capture(file,type); else photos[type].push(await optimizePhoto(file));
          draftDirty = true; drawPhotos(); await queueDraft();
        } catch (error) { toast(error.message); }
      }
    }).finally(() => {
      pendingPhotos--;
      $('save').disabled = busy || !ready || pendingPhotos > 0;
      updateStorage();
    });
  };
}

$('save').onclick = reliability.singleFlight(async () => {
  if (!ready || busy || pendingPhotos) return;
  if (!hasDraftContent()) {
    toast('Add a photo, a note or supplier detail first.'); return;
  }
  if (!$('email').checkValidity()) { $('supplierDetails').open=true;$('email').reportValidity(); return; }
  setBusy(true);
  try {
    await queueDraft();
    const row = {id:editId || draftId || crypto.randomUUID(),
      createdAt:editId ? loaded.find(record => record.id===editId)?.createdAt || Date.now() : draftCapturedAt||Date.now(),
      updatedAt:Date.now(), photos:{booth:[...photos.booth],card:[...photos.card],product:[...photos.product]}};
    fields.forEach(field => row[field] = $(field).value.trim());
    if(window.recognition) Object.assign(row,recognition.snapshot());
    if(window.FairScoutShared?.enabled)await FairScoutShared.save(row,{baseRevision:editId?editRevision:undefined});
    else await reliability.saveSupplier(db,row);
    $('lastSaved').textContent=`Saved ${window.FairScoutCapture?FairScoutCapture.label(row):'supplier'} · ${new Date().toLocaleTimeString()} · on this device`;
    resetForm();
    tab('capture');
    toast('Supplier saved on this device — ready for next booth');
    try { await refresh(); } catch (_) { toast('Supplier saved. Reload to refresh the list.'); }
    await updateStorage();
    window.scrollTo(0,0);
  } catch (error) {
    toast('Supplier NOT saved. Your entry is still open: '+error.message);
  } finally { setBusy(false); if(window.FairScoutShared?.enabled)FairScoutShared.sync().catch(error=>toast(error.message)); }
});

async function updateStorage() {
  const label = $('storageStatus');
  if (!navigator.storage?.estimate) { label.textContent = 'Storage estimate unavailable. Export a JSON backup regularly.'; return; }
  try {
    const {usage=0,quota=0} = await navigator.storage.estimate();
    const mb = bytes => (bytes/1024/1024).toFixed(1)+' MB';
    const low = quota > 0 && (usage/quota >= 0.8 || quota-usage < 100*1024*1024);
    label.textContent = `${low ? '⚠ Low browser storage. Back up and free device space. ' : ''}App origin storage: ${mb(usage)}${quota ? ' of '+mb(quota) : ''}. Export backups regularly.`;
    label.style.color = low ? '#922' : '';
  } catch (_) { label.textContent = 'Storage estimate unavailable. Export backups regularly.'; }
}

$('restore').onchange = reliability.singleFlight(async event => {
  const file = event.target.files?.[0];
  if (!file || busy || !ready) { event.target.value=''; return; }
  setBusy(true);
  let committed = false;
  try {
    // Decode and validate everything before starting the single write transaction.
    const backup = JSON.parse(await file.text());
    const records = reliability.validateBackup(backup);
    const extra = window.recognition ? recognition.validateBackupExtras(backup,records) : null;
    if (!confirm(`Restore ${records.length} suppliers? Matching records are updated only when the backup is newer. Equal or newer device records are kept. Your unfinished draft is kept.`)) return;
    const counts = window.FairScoutShared?.enabled ? await FairScoutShared.importBackup(records,extra) : extra ? await recognition.restoreBackup(records,extra) : await reliability.restoreRecords(db,records);
    committed = true;
    if(!extra && window.recognition) await recognition.migrate();
    await refresh();
    toast(`Restored: ${counts.added} added, ${counts.updated} updated, ${counts.skipped} kept.`);
    await updateStorage();
  } catch (error) { toast(committed ? 'Restore committed. Reload to refresh the list: '+error.message : 'Restore failed; no partial import was committed: '+error.message); }
  finally { event.target.value=''; setBusy(false); }
});

// Upgrade in place: version 1 supplier records and blobs remain untouched.
async function init() {
  setBusy(true);
  // One active editor per origin prevents two tabs overwriting the same draft.
  if (navigator.locks?.request) {
    await new Promise((resolve,reject) => {
      navigator.locks.request('fair-scout-editor',{ifAvailable:true},async lock => {
        if (!lock) { reject(new Error('Fair Scout is already open. Close the other tab and reload this one.')); return; }
        resolve();
        await new Promise(() => {}); // Released automatically when the document closes.
      }).catch(reject);
    });
  }
  db = await new Promise((resolve,reject) => {
    const request = indexedDB.open('tt-fair-scout',window.FairScoutShared?.enabled?4:3);
    request.onupgradeneeded = () => {
      if(window.FairScoutShared?.enabled)FairScoutShared.upgrade(request.result);
      if (!request.result.objectStoreNames.contains('suppliers')) request.result.createObjectStore('suppliers',{keyPath:'id'});
      if (!request.result.objectStoreNames.contains('drafts')) request.result.createObjectStore('drafts',{keyPath:'id'});
      for(const name of ['images','recognitionJobs']) if(!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name,{keyPath:'id'});
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      if(!window.FairScoutShared?.enabled&&request.error?.name==='VersionError'){
        const existing=indexedDB.open('tt-fair-scout');
        existing.onsuccess=()=>resolve(existing.result);existing.onerror=()=>reject(existing.error);
      }else reject(request.error);
    };
    request.onblocked = () => toast('Close other Fair Scout tabs to finish the storage upgrade.');
  });
  db.onversionchange = () => { db.close(); ready=false; setBusy(true); toast('Storage changed in another tab. Reload this app.'); };
  if(!window.FairScoutShared?.enabled&&db.objectStoreNames.contains('cloudMeta')){
    let linked;await reliability.transaction(db,['cloudMeta'],'readonly',tx=>{tx.objectStore('cloudMeta').get('binding').onsuccess=e=>linked=e.target.result;});
    if(linked)throw Error('Shared workspace configuration is unavailable. Restore its configuration to unlock this device; local work is retained.');
  }
  if(window.FairScoutShared?.enabled)await FairScoutShared.init(db);
  await refresh();
  let draft;
  await reliability.transaction(db,['drafts'],'readonly',tx => {
    const request=tx.objectStore('drafts').get('current');
    request.onsuccess=()=>draft=window.FairScoutShared?.locked?null:request.result;
  });
  if (draft) {
    fields.forEach(field => $(field).value=draft.values[field] ?? '');
    photos=draft.photos; editId=draft.editId; draftId=draft.supplierId; editRevision=draft.cloudBaseRevision??0;draftCapturedAt=draft.capturedAt||draft.savedAt;
    if(window.recognition) recognition.loadRow(draft);
    draftDirty=!!draft.dirty;
    $('keepOriginals').checked=!!draft.keepOriginals;
    drawPhotos();
    $('save').textContent=editId ? 'Update supplier' : 'Save & next booth';
    $('draftState').textContent='Unfinished draft restored';
    toast('Your unfinished supplier draft was restored');
  }
  if(window.recognition&&!window.FairScoutShared?.locked) await recognition.init();
  ready=true; setBusy(false); await updateStorage();
  if(window.FairScoutCapture)await FairScoutCapture.updateNext();
  if(window.FairScoutShared?.locked){for(const control of $('list').querySelectorAll('input,select,button'))control.disabled=true;$('recognitionPanel').hidden=true;}
  else if(window.FairScoutShared?.enabled)FairScoutShared.sync().catch(error=>toast(error.message));
};
init().catch(error => {
  ready=false; setBusy(true);
  $('draftState').textContent='Storage unavailable — collection disabled';
  toast('Cannot open local storage: '+error.message);
});
