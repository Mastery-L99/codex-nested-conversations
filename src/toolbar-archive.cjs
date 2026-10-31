'use strict';
// One instance per official window. Only the last review and this window's
// submitted job can be used through the renderer binding.
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
function createToolbarArchive({serviceFactory, canWrite}) {
  let service, token, jobId, closed=false, revision=0;
  async function call(action, input={}) {
    if (closed) throw Error('批量归档窗口已关闭。');
    const keys={plan:['chatIds','includeDescendants'],confirm:['planToken','backgroundReviewToken'],discard:['planToken'],status:['jobId'],stop:['jobId']};
    if(!Object.hasOwn(keys,action)||!input||typeof input!=='object'||Array.isArray(input)||
      Object.keys(input).some(key=>!keys[action].includes(key)))throw Error('归档请求无效，请重新打开批量归档。');
    if (action==='plan' || action==='confirm') {
      if (!canWrite()) throw Error('批量归档已关闭。');
    }
    if (action==='plan') {
      const {chatIds,includeDescendants}=input;
      if (!Array.isArray(chatIds) || !chatIds.length || chatIds.length>256 ||
          chatIds.some(id=>typeof id!=='string'||!UUID.test(id)) || typeof includeDescendants!=='boolean') {
        throw Error('所选聊天无效，请重新选择。');
      }
      token=null;
      const generation=++revision;
      service??=serviceFactory();
      const review=await service.planArchive({chatIds,includeDescendants});
      if (closed || !canWrite()) throw Error('批量归档已关闭。');
      if(generation!==revision)throw Error('归档范围已经更新，请重新选择。');
      token=review.planToken;
      return review;
    }
    if(action==='discard'){if(input.planToken===token){token=null;revision++;}return null;}
    if (action==='confirm') {
      if (!token || input.planToken!==token) throw Error('确认范围已失效，请重新选择。');
      token=null;
      const args={planToken:input.planToken};
      if(typeof input.backgroundReviewToken==='string')args.backgroundReviewToken=input.backgroundReviewToken;
      const result=await service.confirmArchive(args);
      jobId=result.job.jobId;
      return result.job;
    }
    if ((action==='status'||action==='stop') && jobId && input.jobId===jobId) {
      const result=action==='stop'?await service.stopJob({jobId}):await service.getJob({jobId});
      return result.job;
    }
    throw Error('归档请求已失效，请重新打开批量归档。');
  }
  return {call,invalidate(){token=null;revision++;},async dispose(){closed=true;token=null;await service?.dispose();}};
}
module.exports={createToolbarArchive};
