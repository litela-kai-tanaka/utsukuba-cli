import { test, expect } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setup, next, final, draft } from '../../core/test/drill-flow-fixture';
test('root/manaba CLI completes synthetic foreground attempt with private draft and observed final control',async()=>{
 const s=await setup({mentionsLogin:true});
 const run=async(args:string[])=>{
  const p=Bun.spawn({cmd:['bun','packages/cli/src/index.ts','--base-url',s.config.baseUrl,'--json','--debug',...args],cwd:`${import.meta.dir}/../../..`,env:{...process.env,UTSUKUBA_CLI_HOME:s.home},stdout:'pipe',stderr:'pipe'});
  const [out,err,code]=await Promise.all([new Response(p.stdout).text(),new Response(p.stderr).text(),p.exited]);
  expect(out+err).not.toMatch(/PRIVATE|xy|SessionValue|refresh=/);return {out,err,code};
 };
 try{
 await s.start();
 const opened=await run(['drills','open-attempt','351845','4141433']);expect(opened).toMatchObject({code:0});expect(JSON.parse(opened.out).questions.questions).toHaveLength(1);
 const file=join(s.home,'draft.json');writeFileSync(file,JSON.stringify(draft),{mode:0o600});
 const answered=await run(['manaba','drills','step','351845','4141433','--operation','next','--control',next,'--confirm-target',s.url,'--answers',file]);expect(answered.code).toBe(0);expect(JSON.parse(answered.out).submitted).toBe(false);
 const submitted=await run(['drills','step','351845','4141433','--operation','submit','--control',final,'--confirm-target',s.url]);expect(submitted.code).toBe(0);
 const verified=await run(['manaba','drills','verify','351845','4141433']);expect(verified.code).toBe(0);expect(JSON.parse(verified.out)).toMatchObject({submitted:true,newLogIds:['11']});
 }finally{s.clean();}
},30000);
