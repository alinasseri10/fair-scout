/* Transport-independent sync. No credentials, timers or UI in this module. */
(function(root){
  'use strict';
  const types=['booth','card','product'];
  const variants=['original','preview','recognition'];
  const normalizeBooth=value=>String(value||'').toUpperCase().replace(/[–—−]/g,'-').replace(/\s+/g,'');
  async function hash(blob){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',await blob.arrayBuffer()))].map(b=>b.toString(16).padStart(2,'0')).join('');}
  function payload(row){
    const result={id:row.id,createdAt:row.createdAt,updatedAt:row.updatedAt,products:structuredClone(row.products||[]),photoIds:Object.fromEntries(types.map(type=>[type,[...(row.photoIds?.[type]||[])]]))};
    const reliability=typeof module!=='undefined'&&module.exports?require('./reliability.js'):root.FairScoutReliability;
    for(const field of reliability.fields)result[field]=String(row[field]??'');
    return result;
  }
  class SyncEngine{
    constructor({repository,adapter,online=()=>true,onChange=()=>{}}){this.repo=repository;this.adapter=adapter;this.online=online;this.onChange=onChange;this.running=null;this.stopped=false;}
    sync(){
      this.requested=true;
      if(this.running)return this.running;
      this.running=(async()=>{let result;do{this.requested=false;result=await this.run();}while(this.requested&&!this.stopped&&!result.error&&!result.offline);return result;})()
        .finally(()=>{this.running=null;this.onChange();});
      return this.running;
    }
    async run(){
      if(this.stopped||!this.online())return {offline:true};
      try{
        const context=await this.adapter.connect();
        const binding=await this.repo.binding();
        if(!binding||binding.locked||context.userId!==binding.userId||context.workspaceId!==binding.workspaceId)throw Error('Sign in with this device’s linked account before synchronizing.');
        if(context.epoch!==binding.epoch)throw Error('Cloud recovery generation changed. Queue preserved; administrator reconciliation required.');
        await this.pull(context);
        const blocked=new Set((await this.repo.all('conflicts')).map(c=>c.supplierId));
        for(const operation of (await this.repo.all('outbox')).sort((a,b)=>a.order-b.order)){
          if(this.stopped||!this.online())break;
          if(blocked.has(operation.supplierId))continue;
          if(operation.userId!==context.userId)throw Error('An outgoing operation belongs to another user.');
          const result=await this.adapter.mutate(operation.request);
          if(result.status==='conflict'){
            await this.repo.conflict(operation,result.record);blocked.add(operation.supplierId);
          }else{
            await this.repo.ack(operation,result.record,result.duplicates||[]);
          }
          this.onChange();
        }
        // Derivatives may finish after Save. Discover them on each foreground sync.
        for(const row of await this.repo.all('suppliers'))if(!blocked.has(row.id))await this.repo.queuePhotos(row);
        for(const job of await this.repo.all('photoUploads')){
          if(job.state==='synced'||blocked.has(job.supplierId)||this.stopped||!this.online())continue;
          const supplier=await this.repo.get('suppliers',job.supplierId);
          // Keep recovery bytes, but never retry uploads for deleted/detached photos.
          if(!supplier||!types.some(type=>supplier.photoIds?.[type]?.includes(job.assetId)))continue;
          // Do not publish assets for a supplier whose metadata is still pending.
          if((await this.repo.all('outbox')).some(op=>op.supplierId===job.supplierId))continue;
          const image=await this.repo.get('images',job.assetId),blob=image?.[job.variant];
          if(!blob){await this.repo.photoState(job,{state:'failed',error:'Original/copy unavailable locally. No local data was removed.'});continue;}
          try{
            const checksum=await hash(blob);
            const metadata={workspace_id:context.workspaceId,epoch:context.epoch,supplier_id:job.supplierId,asset_id:job.assetId,variant:job.variant,kind:image.type,name:image.name||'photo',mime:blob.type,bytes:blob.size,checksum};
            const slot=await this.adapter.reservePhoto(metadata);
            if(!slot.verified){
              try{await this.adapter.upload(slot,blob,job,patch=>this.repo.photoState(job,patch));}
              catch(error){
                // A response can be lost AFTER a complete upload. Only byte verification
                // can turn such an error into success; HTTP 409 alone cannot.
                try{await this.adapter.verifyPhoto(metadata);}catch(_){throw error;}
              }
            }
            const verified=await this.adapter.verifyPhoto(metadata);
            if(!verified.verified||verified.checksum!==checksum||Number(verified.bytes)!==blob.size)throw Error('Server photo verification did not match the local original.');
            await this.repo.photoState(job,{state:'synced',error:'',checksum,bytes:blob.size,uploadUrl:null});
          }catch(error){
            await this.repo.photoState(job,{state:'failed',error:String(error.message)});
            throw error; // Fail quickly; retry only on a later explicit/foreground attempt.
          }
          this.onChange();
        }
        await this.pull(context);await this.repo.meta('lastSync',Date.now());await this.repo.meta('error','');
        return {ok:true};
      }catch(error){await this.repo.meta('error',String(error.message));return {error:String(error.message)};}
    }
    async pull(context){
      let cursor=await this.repo.meta('cursor')||0;
      for(let page=0;page<100;page++){
        if(this.stopped||!this.online())return;
        const result=await this.adapter.pull(cursor,context.epoch);
        if(this.stopped)return;
        if(result.reset_required||result.epoch!==context.epoch)throw Error('Cloud recovery generation changed. Local queue preserved.');
        await this.repo.applyChanges(result.changes,result.cursor);cursor=result.cursor;
        if(!result.more)return;
      }
      throw Error('More cloud changes remain; synchronize again.');
    }
    async ensurePhotos(row){
      const ids=row.photoIds||Object.fromEntries(types.map(t=>[t,[]]));
      const images=[];
      for(const type of types)for(const id of ids[type]||[]){
        let image=await this.repo.get('images',id);
        if(!image?.original){
          if(!this.online())throw Error('This original is not downloaded on this phone. Reconnect before editing this supplier.');
          await this.adapter.connect();
          const assets=await this.adapter.photos(row.id);
          const original=assets.find(a=>a.asset_id===id&&a.variant==='original'&&a.verified);
          if(!original)throw Error('An original is still pending upload from the collecting phone. Supplier details remain saved.');
          const blob=await this.adapter.download(original);
          if(blob.size!==Number(original.bytes)||await hash(blob)!==original.checksum)throw Error('Downloaded original failed integrity verification.');
          image={id,supplierId:row.id,type,name:original.name,original:blob,createdAt:row.createdAt,copyState:'original-only',remote:true};
          await this.repo.put('images',image);
        }
        images.push(image);
      }
      return this.repo.hydrate(row,images);
    }
  }
  const api={types,variants,normalizeBooth,hash,payload,SyncEngine};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.FairScoutCloudCore=api;
})(globalThis);
