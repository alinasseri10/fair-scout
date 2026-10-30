/* IndexedDB transactions include the supplier AND outbox. No network work in a transaction. */
(function(root){
  'use strict';
  const core=root.FairScoutCloudCore;
  const stores=['cloudMeta','outbox','remoteBase','conflicts','cloudArchive','photoUploads','cloudPhotos','tombstones'];
  function upgrade(db){for(const name of stores)if(!db.objectStoreNames.contains(name))db.createObjectStore(name,{keyPath:'id'});}
  class Repository{
    constructor(db,config){this.db=db;this.config=config;}
    tx(names,mode,work){return root.FairScoutReliability.transaction(this.db,names,mode,work);}
    async get(name,id){let value;await this.tx([name],'readonly',tx=>{tx.objectStore(name).get(id).onsuccess=e=>value=e.target.result;});return value;}
    async all(name){let values;await this.tx([name],'readonly',tx=>{tx.objectStore(name).getAll().onsuccess=e=>values=e.target.result;});return values;}
    put(name,value){return this.tx([name],'readwrite',tx=>tx.objectStore(name).put(value));}
    async meta(id,value){if(arguments.length===1)return (await this.get('cloudMeta',id))?.value;await this.put('cloudMeta',{id,value});return value;}
    binding(){return this.meta('binding');}
    async save(row,{baseRevision,removeDraft=true,deleted=false,restore=false,reviewJob}={}){
      const binding=await this.binding();
      if(!binding||binding.locked)throw Error('Sign in before editing this shared workspace.');
      const operationId=crypto.randomUUID(),data=core.payload(row);
      await this.tx(['suppliers','drafts','outbox','remoteBase','cloudMeta','tombstones',...(reviewJob?['recognitionJobs']:[])],'readwrite',tx=>{
        const queue=tx.objectStore('outbox'),records=tx.objectStore('suppliers');
        const operations=queue.getAll(),base=tx.objectStore('remoteBase').get(row.id),counter=tx.objectStore('cloudMeta').get('order');
        let left=3;const finish=()=>{
          if(--left)return;
          const previous=operations.result.filter(op=>op.supplierId===row.id).sort((a,b)=>a.order-b.order).at(-1);
          // Imported backups always start at revision zero. They cannot overwrite an
          // existing cloud record, even if the phone/backup timestamp is in the future.
          const revision=restore?0:previous?previous.request.expected_revision+1:baseRevision??base.result?.record?.revision??0;
          const order=(counter.result?.value||0)+1;
          tx.objectStore('cloudMeta').put({id:'order',value:order});
          queue.put({id:operationId,supplierId:row.id,userId:binding.userId,order,request:{operation_id:operationId,workspace_id:binding.workspaceId,epoch:binding.epoch,fair_id:this.config.fairId,supplier_id:row.id,kind:deleted?'delete':'save',expected_revision:revision,data}});
          if(deleted){records.delete(row.id);tx.objectStore('tombstones').put({id:row.id,local:true,data});}
          else records.put({...row,_cloud:row._cloud||{revision:base.result?.record?.revision||0},fairId:this.config.fairId});
          if(removeDraft)tx.objectStore('drafts').delete('current');
          if(reviewJob)tx.objectStore('recognitionJobs').put(reviewJob);
        };
        operations.onsuccess=finish;base.onsuccess=finish;counter.onsuccess=finish;
      });
      return operationId;
    }
    async applyChanges(changes,cursor){
      await this.tx(['suppliers','outbox','remoteBase','cloudPhotos','tombstones','cloudMeta'],'readwrite',tx=>{
        const pending=tx.objectStore('outbox').getAll();
        pending.onsuccess=()=>{
          // IDB get callbacks run later. Apply only the final revision per supplier;
          // otherwise an earlier queued get/put can resurrect a later deletion.
          const latest=new Map();
          for(const change of changes)latest.set(change.kind==='photo'?'photo:'+change.record.asset_id+':'+change.record.variant:'supplier:'+change.record.id,change);
          for(const change of latest.values()){
            const record=change.record;
            if(change.kind==='photo'){tx.objectStore('cloudPhotos').put({id:record.asset_id+':'+record.variant,...record});continue;}
            tx.objectStore('remoteBase').put({id:record.id,record});
            if(record.deleted)tx.objectStore('tombstones').put({id:record.id,record});
            if(pending.result.some(op=>op.supplierId===record.id))continue;
            this.applyRecord(tx,record);
          }
          tx.objectStore('cloudMeta').put({id:'cursor',value:cursor});
        };
      });
    }
    applyRecord(tx,record){
      const store=tx.objectStore('suppliers');
      if(record.deleted){store.delete(record.id);return;}
      const current=store.get(record.id);
      current.onsuccess=()=>{
        const old=current.result;
        // Preserve original blobs locally. New remote originals download only when
        // opening that record; edit is blocked until all referenced originals exist.
        const photos=Object.fromEntries(core.types.map(type=>{
          const available=(record.data.photoIds?.[type]||[]).map(id=>old?.photos?.[type]?.[old?.photoIds?.[type]?.indexOf(id)]);
          return [type,available.every(Boolean)?available:[]];
        }));
        store.put({...record.data,photos,_cloud:{revision:record.revision,createdBy:record.created_by,updatedBy:record.updated_by},fairId:record.fair_id});
      };
    }
    async ack(operation,record,duplicates){
      await this.tx(['suppliers','outbox','remoteBase','cloudMeta','tombstones'],'readwrite',tx=>{
        tx.objectStore('outbox').delete(operation.id);
        tx.objectStore('remoteBase').put({id:record.id,record});
        if(record.deleted)tx.objectStore('tombstones').put({id:record.id,record});
        const rest=tx.objectStore('outbox').getAll();
        rest.onsuccess=()=>{
          if(!rest.result.some(op=>op.supplierId===record.id))this.applyRecord(tx,record);
        };
        tx.objectStore('cloudMeta').put({id:'duplicates:'+record.id,value:duplicates});
      });
    }
    conflict(operation,server){return this.put('conflicts',{id:operation.id,supplierId:operation.supplierId,local:operation.request,server,detectedAt:Date.now()});}
    async queuePhotos(row){
      const base=await this.get('remoteBase',row.id);if(!base||base.record.deleted)return;
      for(const type of core.types)for(const id of row.photoIds?.[type]||[]){
        const image=await this.get('images',id);if(!image||image.remote)continue;
        for(const variant of core.variants){
          if(!image[variant])continue;
          const key=id+':'+variant;
          if(!await this.get('photoUploads',key))await this.put('photoUploads',{id:key,assetId:id,supplierId:row.id,variant,state:'pending',error:''});
        }
      }
    }
    async photoState(job,patch){const current=await this.get('photoUploads',job.id);await this.put('photoUploads',{...current,...job,...patch});Object.assign(job,patch);}
    async hydrate(row,images){
      const current=await this.get('suppliers',row.id);if(!current)throw Error('Supplier was deleted while opening it.');
      const photos=Object.fromEntries(core.types.map(type=>[type,(current.photoIds?.[type]||[]).map(id=>images.find(a=>a.id===id)?.original)]));
      if(Object.values(photos).flat().some(value=>!value))throw Error('Supplier changed while downloading photos. Open it again.');
      const result={...current,photos};await this.put('suppliers',result);return result;
    }
    async importBackup(rows,extra){
      const binding=await this.binding();if(!binding||binding.locked)throw Error('Sign in before importing into a shared workspace.');
      for(const image of extra?.images||[]){
        const existing=await this.get('images',image.id);
        if(existing&&(existing.supplierId!==image.supplierId||existing.type!==image.type||await core.hash(existing.original)!==await core.hash(image.original)))throw Error('Photo ID collision; original protected.');
      }
      const counts={added:0,updated:0,skipped:0};
      await this.tx(['suppliers','images','recognitionJobs','drafts','outbox','cloudMeta'],'readwrite',tx=>{
        const counter=tx.objectStore('cloudMeta').get('order');
        counter.onsuccess=()=>{
          let order=counter.result?.value||0;
          for(const row of rows){
            const operationId=crypto.randomUUID();
            const request=tx.objectStore('suppliers').get(row.id);
            request.onsuccess=()=>{if(!request.result){tx.objectStore('suppliers').put(row);counts.added++;}else counts.skipped++;};
            tx.objectStore('outbox').put({id:operationId,supplierId:row.id,userId:binding.userId,order:++order,request:{operation_id:operationId,workspace_id:binding.workspaceId,epoch:binding.epoch,fair_id:this.config.fairId,supplier_id:row.id,kind:'save',expected_revision:0,data:core.payload(row)}});
          }
          tx.objectStore('cloudMeta').put({id:'order',value:order});
        };
        for(const [name,items] of [['images',extra?.images||[]],['recognitionJobs',extra?.jobs||[]]])for(const item of items){
          const store=tx.objectStore(name);store.get(item.id).onsuccess=e=>{if(!e.target.result)store.put(item);};
        }
        if(extra?.draft){const store=tx.objectStore('drafts');store.get('current').onsuccess=e=>{if(!e.target.result)store.put(extra.draft);};}
      });
      return counts;
    }
    async resolve(supplierId,server,choice){
      if(!['server','copy'].includes(choice))throw Error('Choose a supported conflict resolution.');
      const operations=(await this.all('outbox')).filter(op=>op.supplierId===supplierId);
      const local=await this.get('suppliers',supplierId);
      let copy;
      const clones=[];
      if(choice==='copy'){
        if(!local)throw Error('Local deletion cannot be copied. Export recovery data or use server version.');
        const candidate=operations.at(-1)?.request;
        if(candidate?.kind==='delete')throw Error('A local deletion cannot be copied as a new supplier.');
        copy=structuredClone(candidate?.data||local);copy.id=crypto.randomUUID();copy.createdAt=copy.updatedAt=Date.now();delete copy._cloud;
        copy.photos={booth:[],card:[],product:[]};
        const mapping=new Map();
        for(const type of core.types){
          copy.photoIds[type]=await Promise.all((copy.photoIds?.[type]||[]).map(async id=>{
            const image=await this.get('images',id);if(!image?.original)throw Error('Download originals before copying a conflicted supplier.');
            const newId=crypto.randomUUID();mapping.set(id,newId);copy.photos[type].push(image.original);clones.push({...image,id:newId,supplierId:copy.id,remote:false});return newId;
          }));
        }
        copy.products=(copy.products||[]).map(product=>({...product,id:crypto.randomUUID(),sourcePhotoId:mapping.get(product.sourcePhotoId)||product.sourcePhotoId}));
      }
      const binding=await this.binding();
      if(!binding||binding.locked)throw Error('Sign in before resolving a conflict.');
      // Archive, clones, new supplier and its outgoing operation commit together.
      await this.tx(['outbox','conflicts','cloudArchive','suppliers','remoteBase','images','tombstones','cloudMeta'],'readwrite',tx=>{
        tx.objectStore('cloudArchive').put({id:crypto.randomUUID(),supplierId,operations,local,server,resolvedAt:Date.now(),choice});
        for(const op of operations){tx.objectStore('outbox').delete(op.id);tx.objectStore('conflicts').delete(op.id);}
        for(const clone of clones)tx.objectStore('images').put(clone);
        tx.objectStore('remoteBase').put({id:supplierId,record:server});
        if(server.deleted)tx.objectStore('tombstones').put({id:supplierId,record:server});
        this.applyRecord(tx,server);
        if(copy){
          const counter=tx.objectStore('cloudMeta').get('order');
          counter.onsuccess=()=>{
            const order=(counter.result?.value||0)+1,id=crypto.randomUUID();
            tx.objectStore('cloudMeta').put({id:'order',value:order});
            tx.objectStore('suppliers').put({...copy,fairId:this.config.fairId,_cloud:{revision:0}});
            tx.objectStore('outbox').put({id,supplierId:copy.id,userId:binding.userId,order,request:{operation_id:id,workspace_id:binding.workspaceId,epoch:binding.epoch,fair_id:this.config.fairId,supplier_id:copy.id,kind:'save',expected_revision:0,data:core.payload(copy)}});
          };
        }
      });
      return copy;
    }
  }
  root.FairScoutCloudStore={stores,upgrade,Repository};
})(globalThis);
