import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("CLI questions and draft validation perform one authenticated GET each and generic invalid-file errors",async()=>{
  const home=mkdtempSync(join(tmpdir(),"synthetic-answer-cli-"));
  const calls:{method:string;path:string;cookie:string|null}[]=[];
  const server=Bun.serve({hostname:"127.0.0.1",port:0,fetch(request){
    calls.push({method:request.method,path:new URL(request.url).pathname,cookie:request.headers.get("cookie")});
    return new Response(`<main><fieldset><legend>Choose a safe action</legend><label><input type="radio" name="qid1" value="1" required checked>Alpha</label><label><input type="radio" name="qid1" value="2">Beta</label></fieldset><input type="hidden" name="csrf" value="PRIVATE_SECRET"><a href="/ct/start">Start</a><iframe src="/resource"></iframe></main>`);
  }});
  try {
    const base=`http://127.0.0.1:${server.port}/ct`;
    const dir=join(home,"profiles","default","manaba");mkdirSync(dir,{recursive:true});
    writeFileSync(join(dir,"auth.json"),JSON.stringify({profile:"default",baseUrl:base,cookies:[{name:"session",value:"COOKIE_SECRET"}],credentialStored:false,savedAt:new Date().toISOString()}));
    const file=join(home,"answers.json");
    writeFileSync(file,JSON.stringify({answers:[{questionId:"qid1",optionIds:["2"],reason:"Synthetic reason"}]}));
    const run=async(args:string[])=>{
      const proc=Bun.spawn({cmd:["bun","packages/cli/src/index.ts","--base-url",base,"--json",...args],cwd:`${import.meta.dir}/../../..`,env:{...process.env,UTSUKUBA_CLI_HOME:home},stdout:"pipe",stderr:"pipe"});
      const [stdout,stderr,exitCode]=await Promise.all([new Response(proc.stdout).text(),new Response(proc.stderr).text(),proc.exited]);
      return {stdout,stderr,exitCode};
    };
    const q=await run(["contents","questions","course_42_drill_7_submitlog_123"]);
    expect(q.exitCode).toBe(0);expect(JSON.parse(q.stdout).questions[0].options).toHaveLength(2);
    expect(q.stdout).not.toMatch(/checked|selected|SECRET/);
    const draft=await run(["manaba","contents","answer-plan","course_42_drill_7_submitlog_123","--answers",file]);
    expect(draft.exitCode).toBe(0);
    expect(JSON.parse(draft.stdout)).toMatchObject({valid:true,mode:"draft",submitted:false,answers:[{questionId:"qid1",options:[{optionId:"2",text:"Beta"}],reason:"Synthetic reason"}]});
    expect(calls).toEqual(Array.from({length:2},()=>({method:"GET",path:"/ct/course_42_drill_7_submitlog_123",cookie:"session=COOKIE_SECRET"})));
    writeFileSync(file,'{"PRIVATE_SENSITIVE_INVALID_JSON');
    const invalid=await run(["contents","answer-plan","page_1","--answers",file]);
    expect(invalid.exitCode).toBe(1);expect(invalid.stderr).toContain("Invalid answer draft file");
    expect(invalid.stderr).not.toContain("PRIVATE");expect(invalid.stderr).not.toContain(home);
    expect(calls).toHaveLength(2);
    writeFileSync(file,JSON.stringify({answers:[],__extra:"PRIVATE"}));
    const badSchema=await run(["contents","answer-plan","page_1","--answers",file]);
    expect(badSchema.exitCode).toBe(1);expect(badSchema.stderr).toContain("Invalid answer draft");expect(calls).toHaveLength(2);
  } finally {server.stop(true);rmSync(home,{recursive:true,force:true});}
},30000);
