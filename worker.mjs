import {authenticateReport,Monitor,sendTelegram} from './monitor.mjs';
export class UptimeState{
 constructor(ctx,env){this.ctx=ctx;this.env=env;this.monitors=new Map();}
 async fetch(request){
  const {namespace,report}=await request.json();if(!['production','drill'].includes(namespace))return new Response(null,{status:400});
  if(!this.monitors.has(namespace))this.monitors.set(namespace,new Monitor({storage:this.ctx.storage,namespace,send:message=>sendTelegram(this.env,message)}));
  const monitor=this.monitors.get(namespace),result=report?await monitor.report(report):await monitor.tick();
  return Response.json(result);
 }
}
function state(env,namespace){return env.STATE.get(env.STATE.idFromName(namespace));}
export default{
 async fetch(request,env){
  const url=new URL(request.url);if(request.method==='GET'&&url.pathname==='/healthz')return Response.json({ok:true});
  if(request.method!=='POST'||url.pathname!=='/report')return new Response(null,{status:404});
  try{const report=await authenticateReport(request,env.MONITOR_SECRET);return await state(env,report.namespace).fetch('https://state/report',{method:'POST',body:JSON.stringify({namespace:report.namespace,report})});}
  catch{return Response.json({ok:false,error:'report_rejected'},{status:401});}
 },
 async scheduled(_event,env,ctx){ctx.waitUntil(Promise.all(['production','drill'].map(namespace=>state(env,namespace).fetch('https://state/tick',{method:'POST',body:JSON.stringify({namespace})}).then(r=>{if(!r.ok)throw Error('watchdog_failed');}))))}
};
