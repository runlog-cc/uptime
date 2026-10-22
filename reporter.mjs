import {readFile,writeFile,rename,mkdir} from 'node:fs/promises';
import {dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {observe} from './probes.mjs';
import {signReport,boundedText,sendTelegram} from './monitor.mjs';
export async function fallback(previous,available,namespace,send){
 const state={failures:0,alerted:false,...previous};
 if(available){state.failures=0;if(state.alerted){await send(`${namespace==='drill'?'[DRILL] ':''}RunLog monitor transport RECOVERED: signed reports accepted again.`);state.alerted=false;}}
 else{state.failures++;if(state.failures>=2&&!state.alerted){await send(`${namespace==='drill'?'[DRILL] ':''}RunLog monitor transport DOWN: external reporter cannot confirm monitor delivery. Inspect Cloudflare monitor and GitHub Actions; site observations remain in Actions logs.`);state.alerted=true;}}
 return state;
}
export function modeConfig(mode,monitorURL){
 if(!['production','drill-fail','drill-recover','drill-stall','drill-transport-fail'].includes(mode))throw Error('invalid_mode');
 return {namespace:mode==='production'?'production':'drill',observations:['drill-fail','drill-transport-fail'].includes(mode)?2:1,url:new URL('/report',mode==='drill-transport-fail'?'https://monitor-unavailable.invalid':monitorURL)};
}
export async function main(mode='production',env=process.env){
 const {namespace,observations,url}=modeConfig(mode,env.MONITOR_URL);
 if(url.protocol!=='https:'||url.username||url.password)throw Error('invalid_monitor_url');
 const path=env.MONITOR_STATE_FILE;if(!path)throw Error('state_file_required');let cache={};try{cache=JSON.parse(await readFile(path,'utf8'));}catch{}
 let failed=false;
 for(let index=0;index<observations;index++){
  const checks=await observe({drillFailure:mode==='drill-fail'}),report={version:1,namespace,run_id:`${env.GITHUB_RUN_ID||Date.now()}-${env.GITHUB_RUN_ATTEMPT||1}-${index}`,observed_at:new Date().toISOString(),checks,...(mode==='drill-stall'?{expire_heartbeat:true}:{})};
  let accepted=false,receipt=null;try{const response=await fetch(url,{method:'POST',redirect:'error',signal:AbortSignal.timeout(10000),headers:await signReport(report,env.MONITOR_SECRET),body:JSON.stringify(report)});receipt=JSON.parse(await boundedText(response,8192));accepted=response.ok&&receipt.ok===true&&receipt.delivery_pending===false;}catch{}
  try{cache[namespace]=await fallback(cache[namespace],accepted,namespace,message=>sendTelegram(env,message));}catch{failed=true;cache[namespace]={...cache[namespace],failures:Math.max(2,cache[namespace]?.failures||0)};}
  await mkdir(dirname(path),{recursive:true});await writeFile(`${path}.tmp`,JSON.stringify(cache),{mode:0o600});await rename(`${path}.tmp`,path);
  console.log(JSON.stringify({namespace,run_id:report.run_id,checks,monitor_accepted:accepted,receipts:receipt?.receipts||[],last_delivery_error:receipt?.last_delivery_error||null}));
  failed||=!accepted||checks.some(c=>!c.ok);
 }
 return failed?1:0;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){try{process.exitCode=await main(process.argv[2]);}catch{console.error('uptime_report_failed');process.exitCode=1;}}
