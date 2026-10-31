'use strict';
// Render the actual MCP resource against a synthetic desktop bridge.
// No Codex host, original sidebar, model call or desktop launch is involved.
const test=require('node:test');
const assert=require('node:assert/strict');
const {PassThrough}=require('node:stream');
const {chromium}=require('playwright');
const {serveArchiveStdio,NESTING_URI}=require('../src/archive-server.cjs');
const id=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');

test('official side panel supports nested browsing, focused branches, refresh, and explicit navigation only',async t=>{
  const input=new PassThrough(),output=new PassThrough(),messages=[];
  output.on('data',chunk=>messages.push(JSON.parse(chunk)));
  const server=serveArchiveStdio({input,output,service:{dispose:async()=>{}}});t.after(()=>server.stop());
  await server.dispatch({jsonrpc:'2.0',id:1,method:'initialize',params:{}});
  await server.dispatch({jsonrpc:'2.0',id:2,method:'resources/read',params:{uri:NESTING_URI}});
  const resource=messages[1].result.contents[0];
  assert.equal(resource.uri,NESTING_URI);assert.match(resource.text,/data-cncc-view="nested"/);
  const browser=await chromium.launch({channel:'msedge',headless:true});t.after(()=>browser.close());
  const page=await browser.newPage({viewport:{width:375,height:680}});
  const external=[];page.on('request',request=>{if(/^https?:/.test(request.url()))external.push(request.url());});
  await page.setContent('<iframe title="Nested conversations" style="width:100%;height:98vh;border:0"></iframe>');
  const chats=[{id:id(1),title:'Operations',parentId:null},{id:id(2),title:'Research',parentId:id(1)},
    {id:id(3),title:'Evidence <script>',parentId:id(2)},{id:id(4),title:'Unlinked',parentId:null},
    {id:id(5),title:'Other root',parentId:null},{id:id(6),title:'Other leaf',parentId:id(5)}];
  await page.evaluate(({html,chats})=>{
    const frame=document.querySelector('iframe');window.calls=[];window.catalog={enabled:true,relationsAvailable:false,relationCoverage:'attached_only',chats};
    window.addEventListener('message',event=>{
      const message=event.data;if(event.source!==frame.contentWindow||message?.jsonrpc!=='2.0'||message.id==null)return;
      const respond=result=>frame.contentWindow.postMessage({jsonrpc:'2.0',id:message.id,result},'*');
      if(message.method==='ui/initialize'){
        respond({protocolVersion:message.params.protocolVersion,hostInfo:{name:'Fixture',version:'1.0'},hostCapabilities:{serverTools:{}},hostContext:{theme:'dark',displayMode:'inline'}});return;
      }
      if(message.method!=='tools/call')throw Error('Unexpected request: '+message.method);
      window.calls.push(message.params);
      if(message.params.name==='list_nested_chats')respond({content:[],structuredContent:window.catalog});
      else if(message.params.name==='open_nested_chat'){
        if(window.deny)respond({isError:true,content:[{type:'text',text:'桌面没有接受此次请求。'}]});
        else respond({content:[],structuredContent:{requestedChatId:message.params.arguments.chatId}});
      }else throw Error('Unexpected tool: '+message.params.name);
    });
    frame.srcdoc=html;
  },{html:resource.text,chats});
  const frame=page.frameLocator('iframe');const open=title=>frame.getByRole('button',{name:'打开 '+title,exact:true});
  await frame.getByRole('heading',{name:'嵌套对话',exact:true}).waitFor();
  await open('Operations').waitFor();assert.equal(await open('Research').count(),0);assert.equal(await open('Unlinked').count(),0);
  await frame.getByText('部分关系记录不可用',{exact:false}).waitFor();
  await frame.getByRole('combobox',{name:'聚焦一个主聊天'}).selectOption(id(1));
  await open('Research').waitFor();assert.equal(await open('Other root').count(),0);
  await frame.getByRole('button',{name:'展开 Research'}).click();await open('Evidence <script>').waitFor();
  await frame.getByRole('searchbox').fill('evidence');
  await open('Operations').waitFor();await open('Evidence <script>').waitFor();
  assert.deepEqual(await page.evaluate(()=>window.calls.map(x=>x.name)),['list_nested_chats']);
  await open('Evidence <script>').click();await frame.getByText('已请求桌面打开「Evidence <script>」。',{exact:true}).waitFor();
  assert.deepEqual(await page.evaluate(()=>window.calls.at(-1).arguments),{chatId:id(3)});
  await page.evaluate(()=>{window.deny=true;});await open('Evidence <script>').click();await frame.getByRole('alert').waitFor();
  assert.equal(await frame.locator('.nest-id').textContent(),id(3));
  await page.evaluate(()=>{window.catalog={enabled:false,chats:[],relationsAvailable:false};});
  await frame.getByRole('button',{name:'刷新'}).click();await frame.getByText('嵌套对话已关闭。',{exact:false}).waitFor();
  assert.equal(await open('Operations').count(),0);
  assert.equal(await page.evaluate(()=>window.calls.filter(x=>x.name==='open_nested_chat').length),2);
  assert.deepEqual(external,[]);
});
