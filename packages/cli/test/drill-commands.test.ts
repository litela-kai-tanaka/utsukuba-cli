import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const landing=`<main><table><tr><th>状態</th><td>受付中</td></tr><tr><th>提出上限</th><td>無制限</td></tr><tr><th>受付終了日時</th><td>未設定</td></tr></table><form method="post" action="course_351845_drill_4141433"><input type="hidden" name="manaba-form" value="FORM_SECRET"><input type="hidden" name="SessionValue1" value="ONE_SECRET"><input type="hidden" name="SessionValue" value="SESSION_SECRET"><input type="submit" name="action_DrillStudent_querystart" value="受験開始"></form></main>`;
test("root and manaba drill commands gate, start once and inspect offline without secret output",async()=>{
 const home=mkdtempSync(join(tmpdir(),"synthetic-drill-cli-"));const calls:string[]=[];
 const server=Bun.serve({hostname:"127.0.0.1",port:0,fetch(req){calls.push(req.method);return new Response(req.method==="GET"?landing:`<main><form><input type="hidden" name="SessionValue" value="RESPONSE_SECRET"><button name="observed_action">Review</button></form></main>`);}});
 const base=`http://127.0.0.1:${server.port}/ct`;const url=base+"/course_351845_drill_4141433";
 const run=async(args:string[])=>{const p=Bun.spawn({cmd:["bun","packages/cli/src/index.ts","--base-url",base,"--json","--debug",...args],cwd:`${import.meta.dir}/../../..`,env:{...process.env,UTSUKUBA_CLI_HOME:home},stdout:"pipe",stderr:"pipe"});const [out,err,code]=await Promise.all([new Response(p.stdout).text(),new Response(p.stderr).text(),p.exited]);expect(out+err).not.toMatch(/SECRET|SessionValue|rawBody|location/);return {out,err,code};};
 try{
  expect((await run(["drills","start","351845","4141433"])).code).toBe(1);
  expect((await run(["manaba","drills","start","351845","4141433","--confirm-start","wrong"])).code).toBe(1);
  expect(calls).toEqual([]);
  const dir=join(home,"profiles","default","manaba");mkdirSync(dir,{recursive:true});writeFileSync(join(dir,"auth.json"),JSON.stringify({profile:"default",baseUrl:base,cookies:[{name:"session",value:"COOKIE_SECRET"}],savedAt:"synthetic"}));
  const start=await run(["drills","start","351845","4141433","--confirm-start",url]);expect(start.code).toBe(0);expect(JSON.parse(start.out).stage).toBe("response-saved");
  const inspect=await run(["manaba","drills","inspect-attempt","351845","4141433"]);expect(inspect.code).toBe(0);expect(JSON.parse(inspect.out).inspection.forms[0].controls[0].name).toBe("observed_action");
  expect((await run(["manaba","drills","start","351845","4141433","--confirm-start",url])).code).toBe(1);
  expect(calls).toEqual(["GET","POST"]);
 }finally{server.stop(true);rmSync(home,{recursive:true,force:true});}
},30000);
