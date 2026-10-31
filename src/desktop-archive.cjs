'use strict';
const {randomUUID} = require('node:crypto');
const {rpcFailure} = require('./archive-app-server.cjs');

const APP_URL = 'app://-/index.html';
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const failure = code => Object.assign(new Error(code), {code});

// Evaluated only in the main frame of the verified, already-connected official window.
// Nothing is installed on window. No request is accepted from an embedded page.
function exchangeInWindow({id, method, threadId, deadline}) {
  if (window !== window.top || location.href !== 'app://-/index.html' ||
      typeof window.electronBridge?.sendMessageFromView !== 'function') return {failed:'DESKTOP_ARCHIVE_UNAVAILABLE'};
  const remaining = deadline - Date.now();
  if (remaining <= 0) return {failed:'APP_SERVER_TIMEOUT'};
  return new Promise(resolve => {
    function finish(result) {
      clearTimeout(timer);
      window.removeEventListener('message', response);
      resolve(result);
    }
    function response(event) {
      const data = event.data;
      // The packaged preload dispatches MessageEvent with only data (no origin or source).
      if (event.source !== null || event.origin !== '' || data?.type !== 'mcp-response' ||
          data.hostId !== 'local' || data.message?.id !== id) return;
      if (data.message.error) {
        const {code,message} = data.message.error;
        finish({error:{code:Number.isSafeInteger(code)?code:null,message:typeof message==='string'?message.slice(0,8192):''}});
        return;
      }
      const result = data.message.result;
      if (!result || typeof result !== 'object' || Array.isArray(result)) return finish({failed:'INVALID_APP_SERVER_RESPONSE'});
      if (method === 'thread/archive') return finish({result:{}});
      const thread = result.thread;
      if (thread?.id !== threadId || (thread.turns && (!Array.isArray(thread.turns) || thread.turns.length))) {
        return finish({failed:'INVALID_THREAD_METADATA'});
      }
      finish({result:{thread:{id:threadId,status:{type:thread.status?.type},turns:[]}}});
    }
    const timer = setTimeout(() => finish({failed:'APP_SERVER_TIMEOUT'}), remaining);
    window.addEventListener('message',response);
    const params = method === 'thread/read' ? {threadId,includeTurns:false} : {threadId};
    const request = {type:'mcp-request',hostId:'local',request:{jsonrpc:'2.0',id,method,params}};
    try {
      Promise.resolve(window.electronBridge.sendMessageFromView(request)).catch(() => finish({failed:'DESKTOP_ARCHIVE_UNAVAILABLE'}));
    } catch { finish({failed:'DESKTOP_ARCHIVE_UNAVAILABLE'}); }
  });
}

function createDesktopRequest(page) {
  return async function desktopRequest(method, threadId, {signal,timeoutMs}) {
    if ((method !== 'thread/read' && method !== 'thread/archive') || !UUID.test(threadId)) throw failure('INVALID_THREAD_ID');
    if (signal?.aborted) throw failure('ABORTED');
    if (page.isClosed() || page.url() !== APP_URL) throw failure('DESKTOP_ARCHIVE_UNAVAILABLE');
    let reply;
    try {
      reply = await page.evaluate(exchangeInWindow,{id:'cncc-archive-'+randomUUID(),method,threadId,deadline:Date.now()+timeoutMs});
    } catch { throw failure('DESKTOP_ARCHIVE_UNAVAILABLE'); }
    if (reply?.error) throw rpcFailure(method,reply.error);
    if (reply?.failed) throw failure(reply.failed);
    if (!reply?.result) throw failure('INVALID_APP_SERVER_RESPONSE');
    return reply.result;
  };
}
module.exports = {createDesktopRequest};
