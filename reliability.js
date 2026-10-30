(function (root) {
  'use strict';
  const fields = ['booth','company','contact','wechat','email','category','factory','price','moq','notes','rating','decision','companyChinese','brand','jobTitle','phone','whatsapp','wechatId','website','address'];
  function transaction(db, stores, mode, work) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(stores, mode);
      let result;
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(tx.error || new Error('Storage transaction aborted.'));
      tx.onerror = () => {}; // Abort, rather than request success, determines failure.
      try { result = work(tx); } catch (error) { tx.abort(); reject(error); }
    });
  }
  function csvValue(value) {
    let text = String(value ?? '');
    if (/^[\s\u0000-\u001f]*[=+\-@]/.test(text) || /^[\t\r\n]/.test(text)) text = "'" + text;
    return '"' + text.replaceAll('"', '""') + '"';
  }
  function decodePhoto(value) {
    if (typeof value !== 'string' || !/^data:image\/[a-z0-9.+-]+;base64,/i.test(value)) throw new Error('Invalid backup photo.');
    const [meta, encoded] = value.split(',');
    if (!encoded || encoded.length > 26 * 1024 * 1024 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new Error('Invalid or oversized backup photo.');
    const binary = atob(encoded);
    return new Blob([Uint8Array.from(binary, c => c.charCodeAt(0))], {type: meta.slice(5, -7)});
  }
  function validateBackup(data) {
    if (!data || data.format !== 'tt-fair-scout-v1' || !Array.isArray(data.suppliers)) throw new Error('Unsupported backup.');
    const ids = new Set();
    return data.suppliers.map(row => {
      if (!row || typeof row.id !== 'string' || !row.id.trim() || row.id.length > 200 || ids.has(row.id)) throw new Error('Invalid or duplicate supplier ID.');
      ids.add(row.id);
      for (const key of ['createdAt','updatedAt']) if (!Number.isSafeInteger(row[key]) || row[key] < 0 || !Number.isFinite(new Date(row[key]).getTime())) throw new Error('Invalid supplier date.');
      const result = {id: row.id, createdAt: row.createdAt, updatedAt: row.updatedAt, photos: {}};
      if(row.captureNumber!=null){
        if(!Number.isSafeInteger(row.captureNumber)||row.captureNumber<1)throw Error('Invalid capture number.');
        result.captureNumber=row.captureNumber;
      }
      for (const field of fields) {
        if (row[field] != null && typeof row[field] !== 'string') throw new Error('Invalid supplier field: ' + field);
        result[field] = row[field] ?? '';
      }
      if (!['','1','2','3','4','5'].includes(result.rating)) throw new Error('Invalid supplier rating.');
      if (!['','Maybe','Shortlist','Reject'].includes(result.decision)) throw new Error('Invalid supplier decision.');
      if (!['','Not verified','Claims factory','Trading company','Factory verified'].includes(result.factory)) throw new Error('Invalid supplier type.');
      if (row.photos != null && (typeof row.photos !== 'object' || Array.isArray(row.photos))) throw new Error('Invalid photo collection.');
      for (const type of ['booth','card','product']) {
        const values = row.photos?.[type] ?? [];
        if (!Array.isArray(values)) throw new Error('Invalid photo collection.');
        result.photos[type] = values.map(decodePhoto);
      }
      if(row.photoIds!=null) {
        result.photoIds={};
        for(const type of ['booth','card','product']) {
          const ids=row.photoIds[type]??[];
          if(!Array.isArray(ids)||ids.length!==result.photos[type].length||ids.some(id=>typeof id!=='string'||!id||id.length>100)) throw Error('Invalid permanent photo IDs');
          result.photoIds[type]=ids;
        }
      }
      result.products=validateProducts(row.products??[]);
      return result;
    });
  }
  function validateProducts(products) {
    const keys=['id','sourcePhotoId','productType','material','gsm','sizes','moq','unitPrice','currency','priceUnit','quotation'];
    if(!Array.isArray(products)||products.length>1000) throw Error('Invalid products');
    return products.map(product=>{
      if(!product||typeof product!=='object'||Array.isArray(product)||Object.keys(product).some(key=>!keys.includes(key))) throw Error('Invalid product');
      const result={};
      for(const key of keys) {if(product[key]!=null && (typeof product[key]!=='string'||product[key].length>4000)) throw Error('Invalid product field');result[key]=product[key]??'';}
      return result;
    });
  }
  async function restoreRecords(db, records) {
    const counts = {added: 0, updated: 0, skipped: 0};
    await transaction(db, ['suppliers','drafts'], 'readwrite', tx => {
      reserveCaptureNumbers(tx,records);
      const store = tx.objectStore('suppliers');
      for (const row of records) {
        const request = store.get(row.id);
        request.onsuccess = () => {
          const existing = request.result;
          if (existing && (existing.updatedAt || existing.createdAt || 0) >= row.updatedAt) { counts.skipped++; return; }
          store.put(row);
          counts[existing ? 'updated' : 'added']++;
        };
      }
    });
    return counts;
  }
  function saveSupplier(db, row) {
    return transaction(db, ['suppliers','drafts'], 'readwrite', tx => {
      const records=tx.objectStore('suppliers'),drafts=tx.objectStore('drafts');
      const existing=records.get(row.id),counter=drafts.get('captureCounter'),count=records.count();
      let left=3;const finish=()=>{
        if(--left)return;
        try{
          row.captureNumber=existing.result?.captureNumber||row.captureNumber||Math.max(counter.result?.value||0,count.result)+1;
          drafts.put({id:'captureCounter',value:Math.max(counter.result?.value||0,row.captureNumber)});
          records.put(row);drafts.delete('current');
        }catch(error){try{tx.abort();}catch(_){} /* onabort rejects the save; draft/counter roll back together. */}
      };
      existing.onsuccess=finish;counter.onsuccess=finish;count.onsuccess=finish;
    });
  }
  function reserveCaptureNumbers(tx,rows){
    const drafts=tx.objectStore('drafts'),request=drafts.get('captureCounter');
    request.onsuccess=()=>drafts.put({id:'captureCounter',value:Math.max(request.result?.value||0,...rows.map(row=>row.captureNumber||0))});
  }
  function singleFlight(action) {
    let pending = false;
    return async function (...args) {
      if (pending) return;
      pending = true;
      try { return await action.apply(this, args); } finally { pending = false; }
    };
  }
  const api = {fields, transaction, csvValue, validateBackup, validateProducts, restoreRecords, saveSupplier, reserveCaptureNumbers, singleFlight, decodePhoto};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FairScoutReliability = api;
})(globalThis);
