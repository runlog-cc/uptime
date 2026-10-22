const encoder=new TextEncoder();
export const STALE_MS=30*60*1000;
const names=['health','home','benchmark'];
function invalid(){throw Error('invalid_report');}
export function validateReport(r,now=Date.now()){
 if(!r||typeof r!=='object'||Object.keys(r).some(k=>!['version','namespace','run_id','observed_at','checks','expire_heartbeat'].includes(k))||r.version!==1||!['production','drill'].includes(r.namespace)||!/^[-\w.]{1,100}$/.test(r.run_id)||typeof r.observed_at!=='string'||!Number.isFinite(Date.parse(r.observed_at))||Math.abs(now-Date.parse(r.observed_at))>300000)invalid();
 if('expire_heartbeat'in r&&(r.namespace!=='drill'||r.expire_heartbeat!==true))invalid();
 if(!Array.isArray(r.checks)||r.checks.length!==3||new Set(r.checks.map(c=>c.name)).size!==3)invalid();
 for(const c of r.checks)if(!c||Object.keys(c).some(k=>!['name','ok','status','latency_ms','error'].includes(k))||!names.includes(c.name)||typeof c.ok!=='boolean'||!(c.status===null||Number.isInteger(c.status)&&c.status>=100&&c.status<=599)||!Number.isInteger(c.latency_ms)||c.latency_ms<0||c.latency_ms>120000||![null,'http','network','invalid_content'].includes(c.error)||c.ok&&(c.status!==200||c.error!==null))invalid();
 return r;
}
async function key(secret){if(typeof secret!=='string'||secret.length<32)throw Error('unauthorized');return crypto.subtle.importKey('raw',encoder.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign','verify']);}
export async function signReport(report,secret,now=Date.now()){
 const time=String(now),signature=await crypto.subtle.sign('HMAC',await key(secret),encoder.encode(`${time}\n${JSON.stringify(report)}`));
 return {'content-type':'application/json','x-monitor-time':time,'x-monitor-signature':Array.from(new Uint8Array(signature),b=>b.toString(16).padStart(2,'0')).join('')};
}
export async function boundedText(response,max){
 if(Number(response.headers.get('content-length'))>max)throw Error('body_too_large');
 const reader=response.body?.getReader();if(!reader)return '';let size=0;const chunks=[];
 try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>max)throw Error('body_too_large');chunks.push(value);}}finally{await reader.cancel().catch(()=>{});}
 const bytes=new Uint8Array(size);let at=0;for(const chunk of chunks){bytes.set(chunk,at);at+=chunk.length;}return new TextDecoder().decode(bytes);
}
export async function authenticateReport(request,secret,now=Date.now()){
 const time=request.headers.get('x-monitor-time'),sig=request.headers.get('x-monitor-signature');
 if(!/^\d{13}$/.test(time||'')||Math.abs(now-Number(time))>300000||!/^[a-f0-9]{64}$/.test(sig||''))throw Error('unauthorized');
 let raw;try{raw=await boundedText(request,8192);}catch{throw Error('unauthorized');}
 const bytes=Uint8Array.from(sig.match(/../g),h=>parseInt(h,16));
 if(!await crypto.subtle.verify('HMAC',await key(secret),bytes,encoder.encode(`${time}\n${raw}`)))throw Error('unauthorized');
 let report;try{report=JSON.parse(raw);}catch{invalid();}return validateReport(report,now);
}
function deliveryError(phase,kind,status=null,api_code=null){
 const error=Error('notification_failed');error.diagnostic={phase,kind,status,api_code};return error;
}
function safeDeliveryError(error){
 const d=error?.diagnostic;
 if(!d||!['configuration','request','response','acknowledgment'].includes(d.phase)||!['missing_binding','invalid_binding','transport','invalid_body','http','api','recipient'].includes(d.kind))return {phase:'request',kind:'transport',status:null,api_code:null};
 return {...(d.kind==='transport'?{runtime_code:['unsupported_redirect','illegal_invocation','timeout','other'].includes(d.runtime_code)?d.runtime_code:'other'}:{}),phase:d.phase,kind:d.kind,status:Number.isInteger(d.status)&&d.status>=100&&d.status<=599?d.status:null,api_code:Number.isInteger(d.api_code)&&d.api_code>=100&&d.api_code<=599?d.api_code:null};
}
export async function sendTelegram(env,message,fetcher=fetch){
 if(typeof env.TELEGRAM_BOT_TOKEN!=='string'||typeof env.TELEGRAM_CHAT_ID!=='string'||!env.TELEGRAM_BOT_TOKEN||!env.TELEGRAM_CHAT_ID)throw deliveryError('configuration','missing_binding');
 if(env.TELEGRAM_BOT_TOKEN.trim()!==env.TELEGRAM_BOT_TOKEN||!/^[-]?\d+$/.test(env.TELEGRAM_CHAT_ID))throw deliveryError('configuration','invalid_binding');
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),5000);let response;
 try{response=await fetcher(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,{method:'POST',redirect:'manual',signal:controller.signal,headers:{'content-type':'application/json'},body:JSON.stringify({chat_id:env.TELEGRAM_CHAT_ID,text:message,disable_web_page_preview:true})});}
 catch(cause){clearTimeout(timer);const error=deliveryError('request','transport'),text=typeof cause?.message==='string'?cause.message.toLowerCase():'';error.diagnostic.runtime_code=text.includes('redirect')&&(text.includes('unsupported')||text.includes('not implemented'))?'unsupported_redirect':text.includes('illegal invocation')?'illegal_invocation':controller.signal.aborted||['AbortError','TimeoutError'].includes(cause?.name)?'timeout':'other';throw error;}
 try{
  if(response.status>=300&&response.status<400)throw deliveryError('response','http',response.status);
  let body;try{body=JSON.parse(await boundedText(response,16384));}catch{throw deliveryError('response','invalid_body',response.status);}
  const code=Number.isInteger(body.error_code)?body.error_code:null;
  if(!response.ok)throw deliveryError('response','http',response.status,code);
  if(body.ok!==true)throw deliveryError('response','api',response.status,code);
  if(!Number.isInteger(body.result?.message_id)||String(body.result?.chat?.id)!==env.TELEGRAM_CHAT_ID)throw deliveryError('acknowledgment','recipient',response.status);
  return {message_id:body.result.message_id};
 }finally{clearTimeout(timer);}
}
export class Monitor{
 constructor({storage,namespace,send}){if(!['production','drill'].includes(namespace))throw Error('namespace');Object.assign(this,{storage,namespace,send});this.queue=Promise.resolve();}
 serial(fn){const work=this.queue.then(fn);this.queue=work.catch(()=>{});return work;}
 async load(){return await this.storage.get('state')||{heartbeat_at:null,last_observed:0,recent:[],failures:0,down:false,stalled:false,outbox:[],sequence:0};}
 event(s,text,now){s.sequence++;s.outbox.push({id:s.sequence,text:(this.namespace==='drill'?'[DRILL] ':'')+text,attempts:0,next:now});/* At most four transition types can accumulate per observation. */if(s.outbox.length>32)s.outbox=s.outbox.slice(-32);}
 async flush(s,now){
  await this.storage.put('state',s);
  for(let count=0;count<2&&s.outbox.length;count++){
   const event=s.outbox[0];if(event.next>now)break;
   try{const receipt=await this.send(event.text);s.receipts=[...(s.receipts||[]),{event_id:event.id,message_id:receipt?.message_id||null,delivered_at:new Date(now).toISOString()}].slice(-8);s.outbox.shift();s.last_delivery_error=null;}catch(error){s.last_delivery_error={...safeDeliveryError(error),event_id:event.id,observed_at:new Date(now).toISOString()};event.attempts++;event.next=now+Math.min(1800000,60000*2**Math.min(event.attempts,5));await this.storage.put('state',s);break;}
   await this.storage.put('state',s);
  }
  return {ok:true,delivery_pending:s.outbox.length>0,down:s.down,stalled:s.stalled,receipts:s.receipts||[],last_delivery_error:s.last_delivery_error||null};
 }
 report(report,now=Date.now()){return this.serial(async()=>{
  validateReport(report,now);if(report.namespace!==this.namespace)throw Error('namespace');const s=await this.load();
  const observed=Date.parse(report.observed_at);
  if(!s.recent.includes(report.run_id)&&observed>s.last_observed){
   s.recent=[...s.recent,report.run_id].slice(-64);s.last_observed=observed;s.heartbeat_at=now;
   if(s.stalled){s.stalled=false;this.event(s,'RunLog external monitor RECOVERED: independent observations resumed.',now);}
   if(report.checks.every(c=>c.ok)){s.failures=0;if(s.down){s.down=false;this.event(s,'RunLog public service RECOVERED: health, homepage and benchmark feed passed.',now);}}
   else{if(++s.failures>=2&&!s.down){s.down=true;this.event(s,`RunLog public service DOWN: ${report.checks.filter(c=>!c.ok).map(c=>c.name).join(', ')} failed two observations. Check https://runlog.cc`,now);}}
   if(report.expire_heartbeat){s.heartbeat_at=now-STALE_MS-1;this.stale(s,now);}
  }
  return this.flush(s,now);
 });}
 stale(s,now){if(s.heartbeat_at!==null&&now-s.heartbeat_at>STALE_MS&&!s.stalled){s.stalled=true;this.event(s,'RunLog external monitor STALLED: no new GitHub observation for 30 minutes. Check scheduled Actions and the reporter.',now);}}
 tick(now=Date.now()){return this.serial(async()=>{const s=await this.load();if(s.heartbeat_at===null&&this.namespace==='production')s.heartbeat_at=now;this.stale(s,now);return this.flush(s,now);});}
}
