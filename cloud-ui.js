/* Optional integration with the existing globals/capture workflow. Default is local only. */
(function(){
  'use strict';
  const config=window.FAIR_SCOUT_CLOUD||{enabled:false};
  const api={enabled:!!config.enabled,locked:false,config,engine:null,repo:null};
  const core=FairScoutCloudCore;
  let adapter,binding,refreshing=false,retryPaused=false;
  const el=(tag,text)=>{const node=document.createElement(tag);if(text!=null)node.textContent=text;return node;};
  function notify(error){$('cloudStatus').textContent=String(error.message||error);}
  api.guard=()=>{if(api.enabled&&api.locked)throw Error('Sign in to this phone’s linked workspace account.');};
  api.upgrade=FairScoutCloudStore.upgrade;
  api.init=async function(database){
    if(!api.enabled)return;
    api.repo=new FairScoutCloudStore.Repository(database,config);
    binding=await api.repo.binding();api.locked=!binding||!!binding.locked;
    if(binding&&(binding.workspaceId!==config.workspaceId||binding.fairId&&binding.fairId!==config.fairId||binding.url&&binding.url!==config.url))throw Error('This device is linked to a different workspace/fair. Restore its configuration or use a separate browser profile. Local work is retained.');
    adapter=new FairScoutCloudAdapter.SupabaseAdapter(config,{session:await api.repo.meta('session'),onSession:session=>api.repo.meta('session',session)});
    api.engine=new core.SyncEngine({repository:api.repo,adapter,online:()=>navigator.onLine,onChange:()=>api.status().catch(notify)});
    const panel=el('section');panel.className='panel';panel.id='cloudPanel';
    panel.append(el('h2','Tee Thrones · shared workspace'));
    const status=el('p','Sign in to enable shared collection.');status.id='cloudStatus';status.className='note';status.setAttribute('role','status');panel.append(status);
    const form=el('form');form.id='cloudLogin';form.className='split';
    const email=el('input');email.id='cloudEmail';email.type='email';email.autocomplete='username';email.placeholder='Your email';email.required=true;email.setAttribute('aria-label','Workspace email');
    const password=el('input');password.id='cloudPassword';password.type='password';password.autocomplete='current-password';password.placeholder='Password';password.required=true;password.setAttribute('aria-label','Workspace password');
    const signIn=el('button','Sign in');signIn.className='primary';signIn.type='submit';form.append(email,password,signIn);panel.append(form);
    const actions=el('div');actions.className='actions';
    const button=(id,text,action)=>{const node=el('button',text);node.id=id;node.type='button';node.className='secondary';node.onclick=()=>Promise.resolve(action()).catch(notify);actions.append(node);return node;};
    button('cloudSync','Sync now',()=>api.sync());
    button('cloudAdopt','Queue existing local suppliers',async()=>{
      api.guard();const pending=new Set((await api.repo.all('outbox')).map(op=>op.supplierId));
      const rows=[];for(const row of await api.repo.all('suppliers'))if(!pending.has(row.id)&&!await api.repo.get('remoteBase',row.id))rows.push(row);
      if(!confirm(`Queue ${rows.length} local suppliers for this workspace? Existing cloud IDs require conflict review. Export a JSON backup first.`))return;
      await api.importBackup(rows);await api.sync();
    });
    button('cloudExport','Export shared records + originals',async()=>{
      api.guard();await api.sync();
      if(await api.repo.meta('error'))throw Error('Cloud export could not confirm current workspace state. Local JSON backup is still available.');
      for(const row of await api.repo.all('suppliers'))await api.engine.ensurePhotos(row);
      await recognition.exportBackup();
    });
    button('cloudRecovery','Export sync recovery archive',async()=>{
      api.guard();download(new Blob([JSON.stringify(await api.exportRecovery())],{type:'application/json'}),'fair-scout-sync-recovery.json');
    });
    button('cloudLogout','Sign out',async()=>{
      if(busy||pendingPhotos)throw Error('Wait for the current save or photo to finish before signing out.');
      if(!confirm('Sign out on this phone? Local records, photos and pending changes remain protected in the app for the same account. They are not deleted.'))return;
      await draftChain;
      if(draftError)throw Error('The draft could not be saved. Keep this page open and export a backup.');
      api.locked=true;
      api.engine.stopped=true;binding={...binding,locked:true};await api.repo.meta('binding',binding);
      resetForm();$('recognitionPanel').hidden=true;$('recognitionJobs').replaceChildren();$('recognitionReview').close();
      await refresh();setBusy(false);await api.status();
      // Finish an in-flight refresh before removing its credentials.
      await api.engine.running;
      try{await adapter.signOut();}finally{location.reload();}
    });
    button('cloudResetPassword','Send password reset',async()=>{if(!email.value)throw Error('Enter your account email first.');await adapter.resetPassword(email.value);status.textContent='If authorized, a password recovery email will be sent. Use its link in this installed app/browser.';});
    panel.append(actions);
    const conflicts=el('div');conflicts.id='cloudConflicts';panel.append(conflicts);
    document.querySelector('main').prepend(panel);
    form.onsubmit=async event=>{
      event.preventDefault();signIn.disabled=true;
      try{
        const context=await adapter.signIn(email.value,password.value);
        if(binding&&(binding.userId!==context.userId||binding.workspaceId!==context.workspaceId)){await adapter.signOut();throw Error('This phone is linked to another account. Use a separate browser profile; local work was retained.');}
        binding={...context,epoch:binding?.epoch||context.epoch,fairId:config.fairId,url:config.url,locked:false};await api.repo.meta('binding',binding);password.value='';location.reload();
      }catch(error){notify(error);}finally{signIn.disabled=false;}
    };
    // Supabase recovery links can contain a short-lived implicit recovery session.
    // Remove the fragment immediately; never cache it or include it in exports.
    const fragment=new URLSearchParams(location.hash.slice(1));
    if(['recovery','invite'].includes(fragment.get('type'))&&fragment.has('access_token')){
      const recovery={access_token:fragment.get('access_token'),refresh_token:fragment.get('refresh_token'),expires_at:Math.floor(Date.now()/1000)+Number(fragment.get('expires_in')||3600)};
      history.replaceState(null,'',location.pathname);
      adapter.session=recovery;
      const recover=el('form');recover.id='cloudPasswordRecovery';
      const newPassword=el('input');newPassword.type='password';newPassword.minLength=12;newPassword.required=true;newPassword.autocomplete='new-password';newPassword.placeholder='New password (12+ characters)';newPassword.setAttribute('aria-label','New password');
      const submit=el('button','Set new password');submit.className='primary';recover.append(newPassword,submit);panel.append(recover);
      recover.onsubmit=async event=>{event.preventDefault();try{await adapter.changePassword(newPassword.value);await adapter.signOut();location.replace(location.pathname);}catch(error){notify(error);}};
    }
    await api.status();
    if(!api.locked&&binding.role==='owner'){
      const members=el('details');members.id='cloudMembership';members.append(el('summary','Manage workspace members'));
      const memberList=el('div');memberList.id='cloudMemberList';members.append(memberList);
      const loadMembers=async()=>{
        api.guard();const rows=await adapter.members();memberList.replaceChildren();
        for(const member of rows){
          const item=el('p',`${member.email||member.user_id} · ${member.role} · ${member.active?'active':'inactive'}`);
          if(member.role==='editor'){
            const toggle=el('button',member.active?'Revoke access':'Restore editor access');toggle.type='button';toggle.className='secondary';
            toggle.onclick=async()=>{try{if(confirm(toggle.textContent+' for '+(member.email||member.user_id)+'?')){await adapter.setMember(member.user_id,!member.active);await loadMembers();}}catch(error){notify(error);}};item.append(toggle);
          }
          memberList.append(item);
        }
      };
      const load=el('button','Refresh members');load.type='button';load.className='secondary';load.onclick=()=>loadMembers().catch(notify);members.append(load);
      const memberForm=el('form');const user=el('input');user.placeholder='Existing invited account UUID';user.setAttribute('aria-label','Editor account UUID');user.required=true;
      const add=el('button','Grant editor access');add.type='submit';add.className='secondary';memberForm.append(user,add);
      memberForm.onsubmit=async event=>{event.preventDefault();try{api.guard();if(!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(user.value.trim()))throw Error('Enter the invited account UUID from Supabase.');await adapter.setMember(user.value.trim(),true);user.value='';await loadMembers();}catch(error){notify(error);}};
      members.append(el('p','Accounts are provisioned privately by the project administrator. Each person sets their own password. This form grants workspace access to an existing account.'),memberForm);panel.append(members);
    }
    const resume=()=>{retryPaused=false;api.sync().catch(notify);};
    window.addEventListener('online',resume);window.addEventListener('offline',()=>api.status().catch(notify));
    window.addEventListener('focus',resume);
    document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')resume();});
    // Receive the other collector's edits while both apps stay open. Stop polling
    // after failure; reconnect/foreground/Save/Sync Now explicitly resumes it.
    setInterval(()=>{if(!retryPaused&&navigator.onLine&&document.visibilityState==='visible')api.sync().catch(notify);},30000);
    // Failed attempts pause periodic retries until an explicit connectivity/user event.
  };
  api.status=async function(){
    if(!api.enabled||!api.repo||!$('cloudStatus')||refreshing)return;
    refreshing=true;
    try{
      const [pending,allPhotos,conflicts,error,rows]=await Promise.all([api.repo.all('outbox'),api.repo.all('photoUploads'),api.repo.all('conflicts'),api.repo.meta('error'),api.repo.all('suppliers')]);
      const photos=allPhotos.filter(p=>rows.some(row=>row.id===p.supplierId&&core.types.some(type=>row.photoIds?.[type]?.includes(p.assetId))));
      $('cloudLogin').hidden=!api.locked;
      for(const id of ['cloudSync','cloudAdopt','cloudExport','cloudRecovery','cloudLogout'])$(id).disabled=api.locked;
      $('cloudStatus').textContent=api.locked?'Sign in. Existing device data is retained; it is hidden until this account returns.':`${navigator.onLine?'Online':'Offline — saved on this device'} · ${binding.role} · ${pending.length} pending record changes · ${photos.filter(p=>p.state!=='synced').length} photos/copies pending · ${photos.filter(p=>p.state==='failed').length} failed · ${conflicts.length} conflicts${error?' · '+error:!pending.length&&!conflicts.length&&!photos.some(p=>p.state!=='synced')?' · Fully synced (download originals before offline viewing on this phone)':''}`;
      const list=$('cloudConflicts');list.replaceChildren();
      if(api.locked){$('cloudMembership')?.remove();return;}
      for(const conflict of conflicts){
        const details=el('details');details.append(el('summary','Conflict: '+conflict.supplierId));
        const pre=el('pre',JSON.stringify({local:conflict.local.data,cloud:conflict.server?.data||null,deleted:conflict.server?.deleted},null,2));pre.style.cssText='white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px';details.append(pre);
        for(const [choice,label] of [['server','Use latest cloud version; archive local changes'],['copy','Keep local version as a new supplier']]){
          const node=el('button',label);node.className='secondary';node.onclick=async()=>{
            try{
              if(busy||pendingPhotos)throw Error('Wait for the current operation.');
              if(!confirm(label+'? Both versions remain in the sync recovery archive.'))return;
              await adapter.connect();const server=await adapter.supplier(conflict.supplierId);
              if(!server)throw Error('Cloud record unavailable. Local changes were retained.');
              await api.repo.resolve(conflict.supplierId,server,choice);await refresh();await api.status();await api.sync();
            }catch(error){notify(error);}
          };details.append(node);
        }
        list.append(details);
      }
    }finally{refreshing=false;}
  };
  api.sync=async function(){
    if(!api.enabled||api.locked||!api.engine||api.engine.stopped||busy||pendingPhotos)return;
    const result=await api.engine.sync();retryPaused=!!result?.error;await refresh();await api.status();return result;
  };
  api.save=async(row,options)=>{api.guard();await api.repo.save(row,options);await api.status();};
  api.remove=row=>api.save(row,{deleted:true,removeDraft:editId===row.id});
  api.ensurePhotos=async row=>{api.guard();return api.engine.ensurePhotos(row);};
  api.importBackup=async(rows,extra)=>{
    api.guard();extra=extra||{images:[],jobs:[]};
    for(const row of rows){row.photoIds??={};for(const type of core.types){row.photoIds[type]=(row.photos?.[type]||[]).map((original,index)=>{const id=row.photoIds[type]?.[index]||crypto.randomUUID();if(!extra.images.some(image=>image.id===id))extra.images.push({id,supplierId:row.id,type,original,name:'imported-photo',createdAt:row.createdAt,copyState:'original-only'});return id;});}}
    const counts=await api.repo.importBackup(rows,extra);
    await recognition.migrate();await api.status();return counts;
  };
  api.exportRecovery=async()=>{
    const output={format:'fair-scout-sync-recovery-v1',exportedAt:new Date().toISOString(),workspaceId:config.workspaceId,fairId:config.fairId};
    async function encode(value){
      if(value instanceof Blob)return {blob:await toBase64(value)};
      if(Array.isArray(value))return Promise.all(value.map(encode));
      if(value&&typeof value==='object'){const result={};for(const [key,item]of Object.entries(value))result[key]=await encode(item);return result;}
      return value;
    }
    // Never export cloudMeta/session: this list intentionally excludes credentials.
    for(const name of ['outbox','conflicts','cloudArchive','tombstones','remoteBase'])output[name]=await encode(await api.repo.all(name));
    return output;
  };
  window.FairScoutShared=api;
})();
