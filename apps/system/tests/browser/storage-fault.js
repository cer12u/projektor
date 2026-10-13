// @module verification
// @role browser-fixture
// Local synthetic QA only. Real IndexedDB requests/transactions are used; the
// explicit fault aborts a native transaction. This is not physical quota exhaustion.
(() => {
  let mode='none';const faults=[];
  const panel=document.createElement('aside');panel.id='qa-storage-controls';panel.style.cssText='padding:10px;border:3px solid #986b00;background:#fff8d8;color:#222';
  const title=document.createElement('strong');title.textContent='Local QA: native IndexedDB abort controls';panel.append(title);
  const status=document.createElement('p');status.id='qa-storage-mode';panel.append(status);
  function display(){status.textContent='Storage fault: '+mode+'; native aborts: '+faults.length;}
  for(const [value,label]of [['none','Allow storage'],['prepare','Abort prepare transaction'],['journal','Abort journal read'],['mark','Abort recovery mark']]){
    const button=document.createElement('button');button.textContent=label;button.type='button';button.addEventListener('click',()=>{mode=value;display();});panel.append(button);
  }
  const evidence=document.createElement('pre');evidence.id='qa-storage-evidence';panel.append(evidence);document.body.prepend(panel);display();
  function abort(store,operationId,stage){faults.push({stage,operationId:typeof operationId==='string'?operationId:null,at:new Date().toISOString(),outcome:'native transaction.abort()'});store.transaction.abort();evidence.textContent=JSON.stringify(faults,null,2);display();}
  const add=IDBObjectStore.prototype.add,put=IDBObjectStore.prototype.put,get=IDBObjectStore.prototype.get;
  IDBObjectStore.prototype.add=function(value,...rest){const request=add.call(this,value,...rest);if(mode==='prepare'&&this.name==='operations'&&this.transaction.objectStoreNames.contains('drafts'))abort(this,value?.operationId,'prepare');return request;};
  IDBObjectStore.prototype.get=function(key){const request=get.call(this,key);if(mode==='journal'&&this.name==='operations'&&this.transaction.mode==='readonly')abort(this,Array.isArray(key)?key[1]:null,'journal');return request;};
  IDBObjectStore.prototype.put=function(value,...rest){const request=put.call(this,value,...rest);if(mode==='mark'&&this.name==='operations'&&!this.transaction.objectStoreNames.contains('drafts')&&value?.queries>0&&!['sending','confirmed','rejected'].includes(value?.phase))abort(this,value?.operationId,'mark');return request;};
  // The launcher is a fixture route, while product navigation uses its normal root.
  history.replaceState(null,'','/?qaStorage=1');
})();
