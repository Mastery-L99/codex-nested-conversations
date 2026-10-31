import {App,PostMessageTransport,applyDocumentTheme,applyHostStyleVariables} from '@modelcontextprotocol/ext-apps';

const UUID=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
function forest(rows) {
  const nodes=new Map();
  for(const row of rows){
    if(!UUID.test(row.id)||nodes.has(row.id))continue;
    nodes.set(row.id,{id:row.id,title:row.title&&row.title!==row.id?row.title:'未命名聊天 · '+row.id.slice(-8),
      parentId:row.parentId,children:[]});
  }
  // An archived parent may be absent. A corrupt cycle must not swallow an
  // entire branch or lead to an infinite walk.
  const finished=new Set();
  for(const node of nodes.values()){
    if(finished.has(node.id))continue;
    const path=new Set();let current=node;
    while(current&&!finished.has(current.id)){
      if(path.has(current.id)){
        for(let member=current;member?.parentId;){
          const next=nodes.get(member.parentId);member.parentId=null;member=next;
        }
        break;
      }
      path.add(current.id);
      current=nodes.get(current.parentId);
    }
    for(const id of path)finished.add(id);
  }
  const roots=[];
  for(const node of nodes.values()){
    const parent=nodes.get(node.parentId);
    if(parent)parent.children.push(node);else roots.push(node);
  }
  return {nodes,roots};
}

export function mountNestingPanel(){
  document.body.innerHTML=`<style>
    .nest{max-width:860px;margin:auto;padding:16px;color:var(--text);font:14px/1.5 system-ui,sans-serif}
    .nest header{display:flex;align-items:center;justify-content:space-between;gap:10px}.nest h1{margin:0;font-size:22px}
    .nest p{margin:9px 0;color:var(--muted);overflow-wrap:anywhere}.nest input,.nest select{width:100%;min-width:0;box-sizing:border-box;margin:6px 0;padding:7px;color:var(--text);background:var(--bg);border:1px solid var(--border);border-radius:7px}
    .nest-list{list-style:none;margin:8px 0;padding:0}.nest-row{display:flex;gap:4px;align-items:center;min-width:0;padding-block:2px;border-bottom:1px solid var(--border)}
    .nest-toggle,.nest-spacer{width:29px;flex:0 0 29px}.nest-toggle,.nest-chat{border:0;background:transparent;color:inherit;border-radius:5px;cursor:pointer}
    .nest-toggle:hover,.nest-chat:hover{background:var(--surface)}.nest-chat{display:flex;align-items:center;gap:6px;flex:1;text-align:left;min-width:0;padding:5px}
    .nest-name{flex:1;overflow-wrap:anywhere}.nest-count{white-space:nowrap;color:var(--muted);font-size:12px}
    .nest [role=alert]{color:var(--danger,var(--text))}.nest button:focus-visible{outline:2px solid currentColor}
    .nest-id{user-select:all;font-family:monospace;overflow-wrap:anywhere}
  </style><main class="nest">
    <header><h1>嵌套对话</h1><button type="button" id="refresh">刷新</button></header>
    <p>展开主聊天查看下级，点击名称在 Codex 桌面打开。</p>
    <label for="chat-query">查找聊天</label><input id="chat-query" type="search" placeholder="标题或聊天 ID">
    <label for="tree-scope">显示范围</label><select id="tree-scope"><option value="related">有下级的主聊天</option><option value="all">全部本机聊天</option></select>
    <label for="root-chat">聚焦一个主聊天</label><select id="root-chat"><option value="">查看全部分支</option></select>
    <p id="coverage" hidden></p><p id="summary" role="status">正在读取本机目录…</p>
    <p id="error" role="alert" hidden></p><ul class="nest-list" id="rows" aria-label="聊天层级"></ul>
    <p id="navigation" role="status"></p>
  </main>`;
  const el=id=>document.getElementById(id);
  let app=null,connected=false,connecting=false,disposed=false,data=null,reading=false,opening=false;
  let tree=forest([]);const expanded=new Set();
  function error(message){el('error').textContent=message;el('error').hidden=!message;}
  async function call(name,args={}){
    const result=await app.callServerTool({name,arguments:args});
    if(result.isError)throw new Error(result.content?.find(item=>item.type==='text')?.text||'插件暂时无法完成操作。');
    if(!result.structuredContent)throw new Error('插件返回的结果不完整。');
    return result.structuredContent;
  }
  function render(){
    const list=el('rows');list.replaceChildren();
    if(!data){
      el('root-chat').replaceChildren(new Option('查看全部分支',''));
      for(const id of ['root-chat','tree-scope','chat-query'])el(id).disabled=true;
      return;
    }
    const enabled=data.enabled===true;
    el('chat-query').disabled=!enabled;el('tree-scope').disabled=!enabled;el('root-chat').disabled=!enabled;
    if(!enabled){el('summary').textContent='嵌套对话已关闭。可在批量归档面板的功能开关中开启。';el('coverage').hidden=true;return;}
    el('coverage').hidden=data.relationsAvailable!==false;
    el('coverage').textContent=data.relationCoverage==='attached_only'?'部分关系记录不可用，目前仅显示本机确认的附属聊天。':'聊天关系暂不可用，可切换到“全部本机聊天”查看。';
    const query=el('chat-query').value.trim().toLocaleLowerCase(), matches=new Set(),visible=new Set();
    if(query){
      for(const node of tree.nodes.values())if((node.title+' '+node.id).toLocaleLowerCase().includes(query)){
        matches.add(node.id);
        for(let ancestor=node;ancestor&&!visible.has(ancestor.id);ancestor=tree.nodes.get(ancestor.parentId))visible.add(ancestor.id);
      }
    }
    const roots=tree.roots.filter(node=>(!el('root-chat').value||el('root-chat').value===node.id)&&(el('tree-scope').value==='all'||node.children.length));
    let count=0;
    const pending=roots.toReversed().map(node=>({node,depth:0}));
    while(pending.length){
      const {node,depth}=pending.pop();
      if(query&&!visible.has(node.id))continue;
      if(!query||matches.has(node.id))count++;
      const row=document.createElement('li');row.className='nest-row';row.style.paddingInlineStart=Math.min(depth,6)*12+'px';
      const hasChildren=node.children.length>0;
      const toggle=document.createElement(hasChildren?'button':'span');toggle.className=hasChildren?'nest-toggle':'nest-spacer';row.append(toggle);
      const open=query?true:expanded.has(node.id);
      if(hasChildren){
        toggle.type='button';toggle.textContent=open?'▾':'▸';toggle.disabled=Boolean(query);
        toggle.setAttribute('aria-expanded',String(open));toggle.setAttribute('aria-label',(open?'收起 ':'展开 ')+node.title);
        toggle.addEventListener('click',()=>{if(open)expanded.delete(node.id);else expanded.add(node.id);render();});
      }
      const chat=document.createElement('button');chat.type='button';chat.className='nest-chat';
      chat.title=node.id;chat.setAttribute('aria-label','打开 '+node.title);chat.disabled=opening||reading;
      const name=document.createElement('span');name.className='nest-name';name.textContent=node.title;chat.append(name);
      if(hasChildren){const badge=document.createElement('span');badge.className='nest-count';badge.textContent=node.children.length+' 个下级';chat.append(badge);}
      chat.addEventListener('click',()=>openChat(node));row.append(chat);list.append(row);
      if(open)for(let i=node.children.length-1;i>=0;i--)pending.push({node:node.children[i],depth:depth+1});
    }
    el('summary').textContent=query?'找到 '+count+' 个聊天':roots.length?'共 '+roots.length+' 个顶层聊天':'当前范围没有可显示的聊天。';
  }
  async function openChat(node){
    if(opening||reading||disposed)return;
    opening=true;error('');render();el('navigation').textContent='';
    try{
      const reply=await call('open_nested_chat',{chatId:node.id});
      if(reply.requestedChatId!==node.id)throw new Error('客户端没有返回所选聊天。');
      el('navigation').textContent='已请求桌面打开「'+node.title+'」。';
    }catch(e){
      error(e.message||'打开失败。');
      const id=document.createElement('span');id.className='nest-id';id.textContent=node.id;el('navigation').append('聊天 ID：',id);
    }finally{opening=false;if(!disposed)render();}
  }
  async function refresh(){
    if(!connected||reading||disposed)return;
    error('');el('navigation').textContent='';reading=true;el('refresh').disabled=true;
    try{
      const catalog=await call('list_nested_chats');
      if(!Array.isArray(catalog.chats)||typeof catalog.enabled!=='boolean')throw new Error('聊天目录格式不完整。');
      data=catalog;tree=forest(data.chats);
      const choice=el('root-chat'),previous=choice.value;
      choice.replaceChildren(new Option('查看全部分支',''));
      for(const root of tree.roots)if(root.children.length)choice.add(new Option(root.title+' · '+root.id.slice(-8),root.id));
      if(tree.roots.some(root=>root.id===previous&&root.children.length))choice.value=previous;
    }catch(e){data=null;tree=forest([]);el('summary').textContent='未能读取聊天目录。';el('coverage').hidden=true;error(e.message);}
    finally{reading=false;el('refresh').disabled=false;if(!disposed)render();}
  }
  function theme(context){
    if(context?.theme)applyDocumentTheme(context.theme);
    if(context?.styles?.variables)applyHostStyleVariables(context.styles.variables);
  }
  async function connect(){
    if(connected||connecting||disposed)return;
    connecting=true;error('');
    try{
      if(window.parent===window)throw new Error('请从官方桌面的插件页面或聊天侧面板打开。');
      if(app)await app.close();
      app=new App({name:'Nested Conversations',version:__CNCC_VERSION__},{},{strict:true,autoResize:false});
      app.onhostcontextchanged=theme;
      app.onteardown=()=>{disposed=true;return {};};
      await app.connect(new PostMessageTransport(window.parent,window.parent),{timeout:8000});
      connected=true;theme(app.getHostContext());await refresh();
    }catch(e){el('summary').textContent='面板尚未连接。';error(e.message);}
    finally{connecting=false;}
  }
  el('refresh').addEventListener('click',()=>connected?refresh():connect());
  el('root-chat').addEventListener('change',()=>{if(el('root-chat').value)expanded.add(el('root-chat').value);render();});
  el('chat-query').addEventListener('input',render);el('tree-scope').addEventListener('change',render);void connect();
}
