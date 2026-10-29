'use strict';
require('./runtime-main.cjs').start().catch(error=>{
  const fs=require('node:fs'),path=require('node:path');
  const data=process.env.CNCC_DATA_DIR||__dirname;
  fs.mkdirSync(data,{recursive:true});
  fs.writeFileSync(path.join(data,'runtime-status.json'),JSON.stringify({state:'startup_failed',processId:process.pid,error:error.message},null,2));
  process.exitCode=1;
});