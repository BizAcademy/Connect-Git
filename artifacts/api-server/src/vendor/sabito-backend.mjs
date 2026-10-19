/**
 * Run on the PLATFORM BACKEND ONLY (Node 21+), never in a browser.
 * Uses the same Sabito-generated SABITO_CLIENT_ID and SABITO_CLIENT_SECRET.
 * Bind handlers to your existing services; perform ownership/permission checks
 * using job.external_user_id. Never search a transaction by ID alone.
 */
export async function startSabitoBackend({handlers,signal,onError=()=>{}}) {
  const url=new URL(process.env.SABITO_URL);
  if (url.protocol!=="https:" || url.username || url.password || url.search || url.hash || url.pathname!=="/")
    throw new Error("SABITO_URL must be an HTTPS origin.");
  const id=process.env.SABITO_CLIENT_ID,secret=process.env.SABITO_CLIENT_SECRET;
  if (!id || !secret) throw new Error("Configure the server-side Sabito-generated credentials.");
  const headers={Authorization:`Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`,"Content-Type":"application/json"};
  const sleep=()=>new Promise(resolve=>{
    let timer;
    const done=()=>{clearTimeout(timer);signal?.removeEventListener("abort",done);resolve();};
    timer=setTimeout(done,250);
    if(signal?.aborted) done(); else signal?.addEventListener("abort",done,{once:true});
  });
  while (!signal?.aborted) {
    try {
      const response=await fetch(`${url.origin}/v1/backend/jobs/poll`,{method:"POST",headers,redirect:"error",
        body:JSON.stringify({operations:Object.keys(handlers).filter(key=>/^[a-z][a-z0-9_]{1,63}$/.test(key)&&typeof handlers[key]==="function")}),
        signal:signal ? AbortSignal.any([signal,AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000)});
      if (!response.ok) throw new Error(`BRIDGE_HTTP_${response.status}`);
      const {jobs}=await response.json();
      await Promise.all(jobs.map(async job=>{
        if (!/^[a-z][a-z0-9_]{1,63}$/.test(job.operation)
          || !/^[0-9a-f-]{36}$/.test(job.id) || Date.parse(job.expires_at)<=Date.now()) return;
        let result={status:"error"};
        try {
          if (Object.hasOwn(handlers,job.operation) && typeof handlers[job.operation]==="function") {
            const remaining=Math.max(1,Date.parse(job.expires_at)-Date.now()-500);
            let timer;
            try {
              result=await Promise.race([handlers[job.operation]({...job,signal:AbortSignal.timeout(remaining)}),
                new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error("HANDLER_TIMEOUT")),remaining);})]);
            } finally {clearTimeout(timer);}
          }
        } catch {onError("BACKEND_HANDLER_FAILED");}
        const submitted=await fetch(`${url.origin}/v1/backend/jobs/${job.id}/result`,{
          method:"POST",headers,redirect:"error",body:JSON.stringify({result}),signal:AbortSignal.timeout(5000)});
        if (!submitted.ok && submitted.status!==404) onError("BACKEND_RESULT_REJECTED");
      }));
    } catch {if (!signal?.aborted) onError("BACKEND_BRIDGE_UNAVAILABLE");}
    if (!signal?.aborted) await sleep();
  }
}
