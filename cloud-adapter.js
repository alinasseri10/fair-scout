/* Supabase Auth/PostgREST/Storage adapter. Only publishable keys belong here. */
(function(root){
  'use strict';
  class SupabaseAdapter{
    constructor(config,{fetchImpl=globalThis.fetch.bind(globalThis),session=null,onSession=async()=>{},online=()=>globalThis.navigator?.onLine!==false}={}){
      const url=new URL(config.url);
      if(url.protocol!=='https:'||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw Error('Supabase requires an exact HTTPS origin.');
      if(!/^sb_publishable_[A-Za-z0-9_-]+$/.test(config.publishableKey||''))throw Error('Only a Supabase publishable key is allowed in the PWA.');
      this.config=config;this.url=url.origin;this.fetch=fetchImpl;this.session=session;this.onSession=onSession;this.online=online;this.refreshing=null;
    }
    headers(token=this.session?.access_token){return {apikey:this.config.publishableKey,...(token?{Authorization:'Bearer '+token}:{})};}
    async request(path,{method='GET',body,headers={},token,raw=false,timeout=10000}={}){
      if(!this.online())throw Error('Offline — local work is saved; cloud requests paused.');
      const response=await this.fetch(path.startsWith('https://')||path.startsWith('/')?path:this.url+path,{method,headers:{...this.headers(token),...(body&&!raw?{'Content-Type':'application/json'}:{}),...headers},body:body==null?undefined:raw?body:JSON.stringify(body),cache:'no-store',redirect:'error',signal:AbortSignal.timeout(timeout)});
      if(!response.ok){let detail;try{detail=await response.json();}catch(_){}const error=Error(detail?.msg||detail?.message||detail?.error_description||detail?.error||`Cloud HTTP ${response.status}`);error.status=response.status;throw error;}
      return response;
    }
    async json(path,options){const response=await this.request(path,options);return response.status===204?null:response.json();}
    async setSession(session){this.session=session;await this.onSession(session);}
    async signIn(email,password){
      const session=await this.json(this.url+'/auth/v1/token?grant_type=password',{method:'POST',body:{email,password},token:''});
      session.expires_at=session.expires_at||Math.floor(Date.now()/1000)+session.expires_in;
      // Check membership before retaining credentials or enabling collection.
      const previous=this.session;this.session=session;
      try{const context=await this.connect();await this.setSession(session);return context;}catch(error){this.session=previous;throw error;}
    }
    async freshToken(){
      if(!this.session?.access_token)throw Error('Sign in to synchronize. Local records remain on this phone.');
      if(this.session.expires_at*1000>Date.now()+60000)return;
      if(!this.refreshing)this.refreshing=(async()=>{
        const session=await this.json(this.url+'/auth/v1/token?grant_type=refresh_token',{method:'POST',body:{refresh_token:this.session.refresh_token},token:''});
        session.expires_at=session.expires_at||Math.floor(Date.now()/1000)+session.expires_in;await this.setSession(session);
      })().finally(()=>this.refreshing=null);
      await this.refreshing;
    }
    async connect(){
      await this.freshToken();
      // One bounded authenticated round trip is the connectivity and identity check.
      const user=await this.json(this.url+'/auth/v1/user');
      const context=await this.rpc('fs_context',{p_workspace:this.config.workspaceId});
      if(!context||context.userId!==user.id)throw Error('Account is not an authorized workspace member.');
      return context;
    }
    async signOut(){
      try{if(this.online()&&this.session)await this.json(this.url+'/auth/v1/logout?scope=local',{method:'POST'});}
      finally{await this.setSession(null);}
    }
    resetPassword(email){return this.json(this.url+'/auth/v1/recover',{method:'POST',body:{email},token:''});}
    changePassword(password){return this.json(this.url+'/auth/v1/user',{method:'PUT',body:{password}});}
    rpc(name,body){return this.json(this.url+'/rest/v1/rpc/'+name,{method:'POST',body});}
    mutate(operation){return this.rpc('fs_apply',{p_operation:operation});}
    pull(cursor,epoch){return this.rpc('fs_pull',{p_workspace:this.config.workspaceId,p_after:cursor,p_epoch:epoch});}
    supplier(id){return this.rpc('fs_supplier',{p_workspace:this.config.workspaceId,p_id:id});}
    members(){return this.rpc('fs_members',{p_workspace:this.config.workspaceId});}
    setMember(userId,active){return this.rpc('fs_set_member',{p_workspace:this.config.workspaceId,p_user:userId,p_active:active});}
    reservePhoto(metadata){return this.rpc('fs_reserve_photo',{p_photo:metadata});}
    photos(id){return this.rpc('fs_photos',{p_workspace:this.config.workspaceId,p_supplier:id});}
    async verifyPhoto(metadata){return this.json('/api/cloud/verify-photo',{method:'POST',body:{workspace_id:metadata.workspace_id,asset_id:metadata.asset_id,variant:metadata.variant},timeout:45000});}
    objectUrl(asset){return this.url+'/storage/v1/object/authenticated/fair-scout-private/'+asset.object_path.split('/').map(encodeURIComponent).join('/');}
    async download(asset){const response=await this.request(this.objectUrl(asset),{timeout:45000});return response.blob();}
    async upload(slot,blob,job,persist){
      // Small TUS implementation: persisted Location + authoritative HEAD offset.
      // Immutable paths, no upsert, and no optimistic 'synced' based on status codes.
      const endpoint=this.url+'/storage/v1/upload/resumable';
      const tus={'Tus-Resumable':'1.0.0'};
      let uploadUrl=job.uploadUrl,offset=0;
      const valid=url=>{const u=new URL(url);if(u.origin!==this.url||!u.pathname.startsWith('/storage/v1/upload/resumable/'))throw Error('Invalid resumable upload location.');return u.href;};
      if(uploadUrl){
        uploadUrl=valid(uploadUrl);
        try{const head=await this.request(uploadUrl,{method:'HEAD',headers:tus});offset=Number(head.headers.get('Upload-Offset'));}
        catch(error){if(![404,410].includes(error.status))throw error;uploadUrl=null;await persist({uploadUrl:null});}
      }
      if(!uploadUrl){
        const metadata={bucketName:'fair-scout-private',objectName:slot.object_path,contentType:blob.type,cacheControl:'0'};
        const create=await this.request(endpoint,{method:'POST',headers:{...tus,'Upload-Length':String(blob.size),'Upload-Metadata':Object.entries(metadata).map(([k,v])=>k+' '+btoa(v)).join(',')}});
        const location=create.headers.get('Location');if(!location)throw Error('Storage did not return a resumable upload location.');
        uploadUrl=valid(new URL(location,endpoint).href);await persist({uploadUrl,state:'pending'});
      }
      if(!Number.isSafeInteger(offset)||offset<0||offset>blob.size)throw Error('Invalid server upload offset.');
      while(offset<blob.size){
        const chunk=blob.slice(offset,offset+6*1024*1024);
        const response=await this.request(uploadUrl,{method:'PATCH',body:chunk,raw:true,headers:{...tus,'Upload-Offset':String(offset),'Content-Type':'application/offset+octet-stream'},timeout:45000});
        const next=Number(response.headers.get('Upload-Offset'));
        if(next!==offset+chunk.size)throw Error('Storage did not acknowledge the complete photo chunk.');
        offset=next;await persist({uploadedBytes:offset});
      }
    }
  }
  if(typeof module!=='undefined'&&module.exports)module.exports={SupabaseAdapter};else root.FairScoutCloudAdapter={SupabaseAdapter};
})(globalThis);
