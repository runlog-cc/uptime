import {boundedText} from './monitor.mjs';
export function healthy(body){return body?.ok===true&&typeof(body.release_sha||body.release)==='string'&&/^[a-f0-9]{40}$/.test(body.release_sha||body.release);}
export function semantic(name,text){
 try{if(name==='home')return /<html[\s>]/i.test(text)&&/<title>RunLog[^<]*Cost and safety tools for AI agents<\/title>/i.test(text)&&['pricer','loop-guard','ship-check','benchmark'].every(path=>new RegExp(`href=["']/${path}/["']`,'i').test(text));
 const body=JSON.parse(text);if(name==='health')return healthy(body);
 if(body.schema==='runlog.work-benchmark.v1'){const num=n=>typeof n==='number'&&Number.isFinite(n)&&n>=0;return body.task_count===9&&Array.isArray(body.models)&&body.models.length>0&&body.models.every(m=>typeof m.id==='string'&&num(m.quality)&&m.quality<=100&&num(m.mean_answer_usd)&&num(m.median_seconds)&&m.median_seconds>0);}
 return body.version==='runlog.public-benchmarks.v3'&&typeof body.run?.id==='string'&&body.run.summary?.graded>0&&Array.isArray(body.models)&&body.models.some(m=>typeof m.id==='string'&&m.summary?.graded>0);
 }catch{return false;}
}
export async function probe(name,url,fetcher=fetch,{attempts=2,delay=ms=>new Promise(resolve=>setTimeout(resolve,ms))}={}){
 if(new URL(url).protocol!=='https:')throw Error('HTTPS required');let result;
 for(let attempt=0;attempt<attempts;attempt++){
  const start=performance.now();let status=null,error='network';
  try{const response=await fetcher(url,{redirect:'error',signal:AbortSignal.timeout(10000),headers:{'user-agent':'RunLog-Uptime/1.0'}});status=response.status;const text=await boundedText(response,name==='benchmark'?4*1024*1024:512*1024);error=status!==200?'http':semantic(name,text)?null:'invalid_content';}catch{}
  result={name,ok:error===null,status,latency_ms:Math.round(performance.now()-start),error};if(result.ok)break;if(attempt+1<attempts)await delay(1000);
 }return result;
}
export async function observe({drillFailure=false,fetcher=fetch}={}){
 return Promise.all([['health',drillFailure?'/__runlog_uptime_drill_missing__':'/healthz'],['home','/'],['benchmark','/benchmark/data/published.json']].map(([name,path])=>probe(name,`https://runlog.cc${path}`,fetcher)));
}
