'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {parseActivePort, validateOwner} = require('../src/connection.cjs');
const port = 9347;
const record = {family:'OpenAI.Codex_2p2nqsd0c76g0',packageVersion:'1.2.3',expectedExe:'C:\\WindowsApps\\Official\\ChatGPT.exe',
  appProcessId:123,mainCount:1,startTimeMs:1000,listeners:[{port,address:'127.0.0.1',processId:123,executable:'C:\\WindowsApps\\Official\\ChatGPT.exe',isChild:false}]};
test('official owner and both loopback addresses are accepted',()=>{
  assert.equal(validateOwner(record,port).appProcessId,123);
  const v=structuredClone(record);v.listeners.push({...v.listeners[0],address:'::1'});assert.equal(validateOwner(v,port).packageVersion,'1.2.3');
});
test('mismatched owners, external listeners, subprocesses and ambiguous main processes are rejected',()=>{
  for(const edit of [v=>v.family='Other',v=>v.mainCount=2,v=>v.mainCount=0,v=>v.listeners=[],
    v=>v.listeners[0].address='0.0.0.0',v=>v.listeners[0].address='::',v=>v.listeners[0].processId=999,
    v=>v.listeners[0].executable='C:\\Other\\ChatGPT.exe',v=>v.listeners[0].isChild=true,
    v=>v.listeners[0].port=9222,v=>v.listeners.push({...v.listeners[0],processId:999})]){
    const v=structuredClone(record);edit(v);assert.throws(()=>validateOwner(v,port),{code:'UNSAFE_ENDPOINT'});
  }
});
test('active-port file accepts only a local port and canonical browser path',()=>{
  const browserPath='/devtools/browser/00000000-0000-0000-0000-000000000001';
  assert.deepEqual(parseActivePort(`\uFEFF9347\r\n${browserPath}\r\n`),{port,browserPath});
  for(const value of ['0\n'+browserPath,'65536\n'+browserPath,'-1\n'+browserPath,'9347\nhttps://example.com',
    '9347\n/devtools/browser/not-a-uuid','9347\n'+browserPath+'\nextra','9347\n//evil/path']){
    assert.throws(()=>parseActivePort(value),{code:'INVALID_ENDPOINT_FILE'});
  }
});
