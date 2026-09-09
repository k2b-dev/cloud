/** This document has an opaque origin. Its CSP is inherited by blob workers.
 * Scripts cannot use the Cloud origin, credentials, persistent storage or network.
 * Only this fixed bridge runs in the iframe; user code runs in a terminable worker. */
export function sandboxDocument() {
  const nonce = crypto.randomUUID().replaceAll("-", "");
  return `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}' blob:; worker-src blob:; connect-src 'none'; img-src 'none'; style-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'"><script nonce="${nonce}">
 let worker, urls=[];
 addEventListener('message',e=>{
   if(e.source!==parent)return;
   if(e.data.type==='boot'&&!worker){
     const runtime=URL.createObjectURL(new Blob(['(()=>{',e.data.runtime,'\\n})();\\n(()=>{',e.data.code,'\\n})();'],{type:'text/javascript'}));
     urls=[runtime];
     worker=new Worker(runtime);
     worker.onmessage=m=>parent.postMessage(m.data,'*');
     worker.onerror=m=>parent.postMessage({type:'error',text:m.message||'Worker failed to start'},'*');

   } else if(e.data.type==='stop'){worker?.terminate();urls.forEach(u=>URL.revokeObjectURL(u));worker=null;}
   else worker?.postMessage(e.data);
 });
 parent.postMessage({type:'bridge-ready'},'*');
 </script>`;
}
