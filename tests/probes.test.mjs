import test from 'node:test';
import assert from 'node:assert/strict';
import {semantic,probe} from '../probes.mjs';
import {fallback,modeConfig} from '../reporter.mjs';
test('semantic probes reject plausible errors and empty benchmark evidence',()=>{
 for(const body of [{},{ok:false,release:'a'.repeat(40)},{ok:true,release:'unreleased'}])assert.equal(semantic('health',JSON.stringify(body)),false);
 assert.equal(semantic('health',JSON.stringify({ok:true,release:'a'.repeat(40)})),true);
 assert.equal(semantic('home','<html>Internal error</html>'),false);
 assert.equal(semantic('home','<html><title>RunLog error</title>Temporarily unavailable</html>'),false);
 assert.equal(semantic('home',`<html><title>RunLog — Cost and safety tools for AI agents</title>${['pricer','loop-guard','ship-check','benchmark'].map(path=>`<a href='/${path}/'>Tool</a>`).join('')}</html>`),true);
 assert.equal(semantic('benchmark',JSON.stringify({version:'runlog.public-benchmarks.v3',run:{id:'test',summary:{graded:10}},models:[]})),false);
});
test('probe retries once, bounds response, and rejects oversized 200 content',async()=>{
 let calls=0;const result=await probe('health','https://example.invalid/',async()=>{calls++;return new Response('x'.repeat(600000));},{delay:async()=>{}});
 assert.equal(result.ok,false);assert.equal(calls,2);
});
test('fallback alerts twice-failed transport and one recovery, with failed sends retried',async()=>{
 const sent=[];let state=await fallback(null,false,'drill',async m=>sent.push(m));assert.equal(sent.length,0);
 await assert.rejects(fallback(state,false,'drill',async()=>{throw Error('no delivery');}));
 state=await fallback(state,false,'drill',async m=>sent.push(m));assert.equal(sent.length,1);assert.match(sent[0],/^\[DRILL\]/);
 state=await fallback(state,false,'drill',async m=>sent.push(m));assert.equal(sent.length,1);
 state=await fallback(state,true,'drill',async m=>sent.push(m));assert.equal(sent.length,2);
 await fallback(state,true,'drill',async m=>sent.push(m));assert.equal(sent.length,2);
});

test('transport failure drill is fixed to reserved invalid host and isolated from production',()=>{
 const config=modeConfig('drill-transport-fail','https://real-monitor.example');
 assert.equal(config.namespace,'drill');assert.equal(config.observations,2);assert.equal(config.url.href,'https://monitor-unavailable.invalid/report');
 const recovery=modeConfig('drill-recover','https://real-monitor.example');assert.equal(recovery.namespace,'drill');assert.equal(recovery.url.hostname,'real-monitor.example');
 assert.equal(modeConfig('production','https://real-monitor.example').namespace,'production');assert.throws(()=>modeConfig('force-production-stall','https://real-monitor.example'),/invalid_mode/);
});

test('fallback persists acknowledged message IDs and preserves them across quiet and failed transitions',async()=>{
 let calls=0;const send=async()=>({message_id:++calls});let state=await fallback(null,false,'drill',send);
 assert.equal(state.last_receipt,undefined);state=await fallback(state,false,'drill',send);assert.deepEqual(state.last_receipt,{message_id:1,transition:'down'});
 state=JSON.parse(JSON.stringify(state));state=await fallback(state,false,'drill',send);assert.equal(calls,1);assert.equal(state.last_receipt.message_id,1);
 await assert.rejects(fallback(state,true,'drill',async()=>{throw Error('not acknowledged');}));assert.equal(state.last_receipt.message_id,1);assert.equal(state.alerted,true);
 state=await fallback(state,true,'drill',send);assert.deepEqual(state.last_receipt,{message_id:2,transition:'recovered'});assert.equal(state.alerted,false);
 state=await fallback(state,true,'drill',send);assert.equal(calls,2);assert.equal(state.last_receipt.message_id,2);
});
test('work benchmark probe accepts complete anonymous aggregates and rejects invalid or empty rows',()=>{
 const body={schema:'runlog.work-benchmark.v1',task_count:9,models:[{id:'vendor/model',quality:90,mean_answer_usd:.001,median_seconds:2}]};
 assert.equal(semantic('benchmark',JSON.stringify(body)),true);
 for(const models of [[],[{...body.models[0],quality:101}],[{...body.models[0],mean_answer_usd:-1}],[{...body.models[0],median_seconds:0}]])assert.equal(semantic('benchmark',JSON.stringify({...body,models})),false);
});
