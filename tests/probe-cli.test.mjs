import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {spawnSync} from 'node:child_process';

test('health CLI fails HTTP 200 when the service reports ok:false',{skip:!existsSync(new URL('../../platform/probe.mjs',import.meta.url))},()=>{
 const script=new URL('../../platform/probe.mjs',import.meta.url).href;
 const child=spawnSync(process.execPath,['--input-type=module','-e',`globalThis.fetch=async()=>Response.json({ok:false,release:'test'});await import(${JSON.stringify(script)});`],{encoding:'utf8'});
 assert.equal(child.status,1,child.stdout+child.stderr);
 assert.equal(JSON.parse(child.stdout).ok,false);
});
