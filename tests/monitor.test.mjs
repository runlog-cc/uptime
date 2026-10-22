import test from 'node:test';
import assert from 'node:assert/strict';
let api;try{api=await import('../monitor.mjs');}catch{}
const start=Date.parse('2026-10-22T06:00:00Z'),secret='a'.repeat(64);
const report=(id,ok=true,namespace='production',time=start)=>({version:1,namespace,run_id:id,observed_at:new Date(time).toISOString(),checks:['health','home','benchmark'].map(name=>({name,ok,status:ok?200:503,latency_ms:1,error:ok?null:'http'}))});
function setup(namespace='production',sender=async()=>{}){
 assert(api,'monitor implementation missing');const values=new Map(),store={get:async key=>structuredClone(values.get(key)),put:async(key,value)=>{values.set(key,structuredClone(value));}};
 const sent=[];return {values,store,sent,monitor:new api.Monitor({storage:store,namespace,send:async message=>{await sender(message);sent.push(message);}})};
}
test('two failed observations alert once and recovery alerts once',async()=>{
 const {monitor,sent}=setup();await monitor.report(report('one',false),start);assert.equal(sent.length,0);
 await monitor.report(report('two',false,'production',start+1000),start+1000);assert.equal(sent.length,1);assert.match(sent[0],/RunLog public service DOWN/);
 await monitor.report(report('three',false,'production',start+2000),start+2000);assert.equal(sent.length,1);
 await monitor.report(report('four',true,'production',start+3000),start+3000);assert.equal(sent.length,2);assert.match(sent[1],/RECOVERED/);
 await monitor.report(report('five',true,'production',start+4000),start+4000);assert.equal(sent.length,2);
});
test('stalled heartbeat and its recovery notify once; replay cannot postpone expiry',async()=>{
 const {monitor,sent,values}=setup();await monitor.report(report('first'),start);
 await monitor.report(report('first'),start+1000);assert.equal(values.get('state').heartbeat_at,start);
 await monitor.tick(start+1800001);await monitor.tick(start+1800002);assert.equal(sent.length,1);assert.match(sent[0],/external monitor STALLED/);
 await monitor.report(report('resume',true,'production',start+1801000),start+1801000);assert.equal(sent.length,2);assert.match(sent[1],/external monitor RECOVERED/);
});
test('notification failure persists an outbox for bounded retry and survives object restart',async()=>{
 let fail=true;const fixture=setup('production',async()=>{if(fail)throw Error('simulated send failure');});
 await fixture.monitor.report(report('one',false),start);await fixture.monitor.report(report('two',false,'production',start+1000),start+1000);
 assert.equal(fixture.sent.length,0);assert.equal(fixture.values.get('state').outbox.length,1);
 fail=false;fixture.monitor=new api.Monitor({storage:fixture.store,namespace:'production',send:async message=>fixture.sent.push(message)});await fixture.monitor.tick(start+301000);assert.equal(fixture.sent.length,1);assert.equal(fixture.values.get('state').outbox.length,0);
});
test('drill expiry is explicitly isolated and production cannot override heartbeat time',async()=>{
 const {monitor,sent}=setup('drill');const expired={...report('drill',true,'drill'),expire_heartbeat:true};
 await monitor.report(expired,start);assert.equal(sent.length,1);assert.match(sent[0],/^\[DRILL\]/);
 assert.throws(()=>api.validateReport({...expired,namespace:'production'},start),/invalid_report/);
 await assert.rejects(monitor.report(report('production'),start+1000),/namespace/);
});
test('HMAC rejects forged, modified, old and production-expiry reports',async()=>{
 assert(api,'monitor implementation missing');const value=report('signed'),headers=await api.signReport(value,secret,start);
 const request=(body=value,h=headers)=>new Request('https://monitor.invalid/report',{method:'POST',headers:h,body:JSON.stringify(body)});
 assert.equal((await api.authenticateReport(request(),secret,start)).run_id,'signed');
 await assert.rejects(api.authenticateReport(request({...value,namespace:'drill'}),secret,start),/unauthorized/);
 await assert.rejects(api.authenticateReport(request(value,{...headers,'x-monitor-signature':'0'.repeat(64)}),secret,start),/unauthorized/);
 await assert.rejects(api.authenticateReport(request(),secret,start+300001),/unauthorized/);
 await assert.rejects(api.authenticateReport(request({...value,expire_heartbeat:true},await api.signReport({...value,expire_heartbeat:true},secret,start)),secret,start),/invalid_report/);
});
test('Telegram transport requires acknowledged delivery and never exposes response or credentials',async()=>{
 assert(api,'monitor implementation missing');const env={TELEGRAM_BOT_TOKEN:'private-token',TELEGRAM_CHAT_ID:'123'};
 await assert.rejects(api.sendTelegram(env,'test',async()=>Response.json({ok:false,description:'private-token'})),/^Error: notification_failed$/);
 await api.sendTelegram(env,'test',async(url,options)=>{assert.equal(JSON.parse(options.body).chat_id,'123');return Response.json({ok:true,result:{message_id:1,chat:{id:123}}});});
});

test('out-of-order observations and simultaneous ticks preserve state and deduplicate delivery',async()=>{
 const {monitor,sent,values}=setup();await monitor.report(report('new',true,'production',start+2000),start+2000);
 await monitor.report(report('old',false,'production',start),start+3000);assert.equal(values.get('state').heartbeat_at,start+2000);assert.equal(values.get('state').failures,0);
 await Promise.all([monitor.tick(start+1803000),monitor.tick(start+1803000)]);assert.equal(sent.length,1);
});
test('production watchdog detects a reporter that never starts; drill remains inert',async()=>{
 const prod=setup(),drill=setup('drill');await prod.monitor.tick(start);await drill.monitor.tick(start);
 await prod.monitor.tick(start+1800001);await drill.monitor.tick(start+1800001);assert.equal(prod.sent.length,1);assert.equal(drill.sent.length,0);
});
test('authentication bounds request size and Telegram rejects a different recipient',async()=>{
 const value={...report('large'),padding:'x'.repeat(9000)},headers=await api.signReport(value,secret,start);
 await assert.rejects(api.authenticateReport(new Request('https://monitor.invalid/report',{method:'POST',headers,body:JSON.stringify(value)}),secret,start),/unauthorized/);
 await assert.rejects(api.sendTelegram({TELEGRAM_BOT_TOKEN:'private',TELEGRAM_CHAT_ID:'123'},'test',async()=>Response.json({ok:true,result:{message_id:1,chat:{id:456}}})),/notification_failed/);
});
