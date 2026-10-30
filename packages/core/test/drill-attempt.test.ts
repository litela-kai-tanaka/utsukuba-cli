import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync, readFileSync, readdirSync, symlinkSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createManabaClient } from "../src/application/manaba-client";
import { ManabaHttpClient } from "../src/infrastructure/http-client";
import { AuthStore } from "../src/infrastructure/auth-store";
import { loadConfig } from "../src/infrastructure/config";

const landing = `<main><table><tr><th>状態</th><td>受付中</td></tr><tr><th>提出上限</th><td>無制限</td></tr><tr><th>受付終了日時</th><td>未設定</td></tr></table><form method="post" action="course_351845_drill_4141433"><input type="hidden" name="manaba-form" value="FORM_SECRET"><input type="hidden" name="SessionValue1" value="ONE_SECRET"><input type="hidden" name="SessionValue" value="SESSION_SECRET"><input type="submit" name="action_DrillStudent_querystart" value="受験開始"></form></main>`;
const started = `<main><form><input type="hidden" name="SessionValue" value="RESPONSE_SECRET"><fieldset><legend>Choose</legend><label><input type="radio" name="q1" value="a">Alpha</label><label><input type="radio" name="q1" value="b">Beta</label></fieldset><button name="action_observed">Review</button></form></main>`;
async function setup(html=landing, unknown=false, responseHtml=started, responseStatus=200) {
 const home=mkdtempSync(join(tmpdir(),"synthetic-drill-"));
 const config=loadConfig({homeDir:home,baseUrl:"http://127.0.0.1:1234/ct"});
 const calls: {url:string;init?:RequestInit}[]=[]; let authReads=0;
 const store=new AuthStore(config); await store.save({profile:config.profile,baseUrl:config.baseUrl,cookies:[],credentialStored:false,savedAt:"synthetic"});
 const original=store.load.bind(store);store.load=async()=>{authReads++;return original();};
 const http=new ManabaHttpClient(config,{fetch:async(input,init)=>{calls.push({url:String(input),init}); if(init?.method==="POST") {
    const root=join(home,"attempts");const reservation=readdirSync(root)[0];
    const pending=JSON.parse(readFileSync(join(root,reservation,"state.json"),"utf8"));
    expect(pending.stage).toBe("post-pending");
    if(unknown)throw Error("TRANSPORT_SECRET");return new Response(responseHtml,{status:responseStatus,headers:{location:"/ct/private?SECRET"}});}return new Response(html);}});
 return {home,config,calls,client:createManabaClient(config,{http,authStore:store}),reads:()=>authReads,clean:()=>rmSync(home,{recursive:true,force:true})};
}
test("start persists one response privately and inspects without rePOST",async()=>{
 const s=await setup();try {
 const result=await s.client.drills.start("351845","4141433",s.config.baseUrl+"/course_351845_drill_4141433");
 expect(result).toMatchObject({stage:"response-saved",httpStatus:200,actionNames:["action_DrillStudent_querystart"]});
 expect(s.calls.map(c=>c.init?.method??"GET")).toEqual(["GET","POST"]);
 expect(s.calls.every(c=>c.init?.redirect==="manual")).toBe(true);
 const post=s.calls[1].init?.body as URLSearchParams;expect(post.get("SessionValue")).toBe("SESSION_SECRET");
 const path=(result as {stateFile:string}).stateFile;
 expect(statSync(path).mode&0o777).toBe(0o600);expect(statSync(join(path,"..")).mode&0o777).toBe(0o700);
 expect(readFileSync(path,"utf8")).toContain("RESPONSE_SECRET");
 const inspect=await s.client.drills.inspectAttempt("351845","4141433");
 expect(inspect.questions?.questions[0].prompt).toBe("Choose");
 expect(inspect.inspection.forms[0].controls).toContainEqual({type:"submit",name:"action_observed",label:"Review"});
 expect(JSON.stringify([result,inspect])).not.toContain("SECRET");
 await expect(s.client.drills.start("351845","4141433",s.config.baseUrl+"/course_351845_drill_4141433")).rejects.toThrow("reserved");
 expect(s.calls).toHaveLength(2);
 }finally{s.clean();}
});
test("inspection redacts even echoed landing secrets and short hidden response values",async()=>{
 const s=await setup(landing,false,started.replace("</main>",'<p>ONE_SECRET tiny</p><input type="hidden" name="flag" value="tiny"></main>'));
 try {await s.client.drills.start("351845","4141433",s.config.baseUrl+"/course_351845_drill_4141433");const output=JSON.stringify(await s.client.drills.inspectAttempt("351845","4141433"));expect(output).not.toMatch(/ONE_SECRET|tiny/);}finally{s.clean();}
});
test("saved attempt refuses tampered binding and symlinked state without requests",async()=>{
 const s=await setup();try{
 const result=await s.client.drills.start("351845","4141433",s.config.baseUrl+"/course_351845_drill_4141433");
 const original=readFileSync(result.stateFile,"utf8");
 const journal=JSON.parse(original);journal.profile="other";
 writeFileSync(result.stateFile,JSON.stringify(journal));
 await expect(s.client.drills.inspectAttempt("351845","4141433")).rejects.toThrow("safely bound");
 rmSync(result.stateFile);const elsewhere=join(s.home,"elsewhere.json");writeFileSync(elsewhere,original,{mode:0o600});symlinkSync(elsewhere,result.stateFile);
 await expect(s.client.drills.inspectAttempt("351845","4141433")).rejects.toThrow("safely bound");
 expect(s.calls).toHaveLength(2);
 }finally{s.clean();}
});
test("redirect response is saved privately and never followed",async()=>{
 const s=await setup(landing,false,started,302);try {const r=await s.client.drills.start("351845","4141433",s.config.baseUrl+"/course_351845_drill_4141433");expect(r.httpStatus).toBe(302);expect(s.calls).toHaveLength(2);expect(readFileSync(r.stateFile,"utf8")).toContain("/ct/private?SECRET");expect(JSON.stringify(r)).not.toContain("SECRET");}finally{s.clean();}
});
test("prior-passed unlimited entrance remains eligible via bounded current status",async()=>{
 const s=await setup(landing.replace("受付中</td>","受付中<br> <strong>受験回数: 1回 (最高得点 100)</strong><br><strong>＜合格済み＞</strong></td>"));try{
 expect((await s.client.drills.start("351845","4141433",s.config.baseUrl+"/course_351845_drill_4141433")).stage).toBe("response-saved");
 }finally{s.clean();}
});
test("unknown transport remains exclusively reserved without leaking errors",async()=>{
 const s=await setup(landing,true);try {
 const result=await s.client.drills.start("351845","4141433",s.config.baseUrl+"/course_351845_drill_4141433");
 expect(result.stage).toBe("unknown");expect(JSON.stringify(result)).not.toContain("SECRET");
 await expect(s.client.drills.start("351845","4141433",s.config.baseUrl+"/course_351845_drill_4141433")).rejects.toThrow("reserved");expect(s.calls).toHaveLength(2);
 }finally{s.clean();}
});
for (const html of [
 landing.replace('action="course_351845_drill_4141433"','action="https://evil.example/steal"'),
 landing.replace('name="action_DrillStudent_querystart"','formaction="https://evil.example/steal" name="action_DrillStudent_querystart"'),
 landing+landing, landing.replace("受付中","受付終了"), landing.replace("無制限","1回"),
 landing.replace("未設定","2020-01-01"), landing.replace('method="post"','method="get"'),
 landing.replace('name="SessionValue"','name="unknown"'),
 landing.replace('type="submit"','disabled type="submit"'),
]) test("ambiguous/unavailable/unsafe form performs GET but never POST",async()=>{
 const s=await setup(html);try{await expect(s.client.drills.start("351845","4141433",s.config.baseUrl+"/course_351845_drill_4141433")).rejects.toThrow("form");expect(s.calls).toHaveLength(1);}finally{s.clean();}
});
test("saved profile origin mismatch fails before GET",async()=>{
 const s=await setup();try{
 const store=new AuthStore(s.config);await store.save({profile:s.config.profile,baseUrl:"https://manaba.tsukuba.ac.jp/ct",cookies:[],credentialStored:false,savedAt:"synthetic"});
 await expect(s.client.drills.start("351845","4141433",s.config.baseUrl+"/course_351845_drill_4141433")).rejects.toThrow("preflight");expect(s.calls).toHaveLength(0);
 }finally{s.clean();}
});
test("unsupported targets and arbitrary origins fail before auth",async()=>{
 const s=await setup();try{
 await expect(s.client.drills.start("1","2","anything")).rejects.toThrow("Unsupported");
 s.config.baseUrl="https://evil.example/ct";
 await expect(s.client.drills.start("351845","4141433","https://evil.example/ct/course_351845_drill_4141433")).rejects.toThrow("Unsupported");
 expect(s.calls).toHaveLength(0);expect(s.reads()).toBe(0);
 }finally{s.clean();}
});
test("private store rejects symlink and Git ancestry before network",async()=>{
 for(const kind of ["symlink","git"]){const s=await setup();try{
 if(kind==="symlink")symlinkSync(s.home,join(s.home,"attempts"));else mkdirSync(join(s.home,".git"));
 await expect(s.client.drills.start("351845","4141433",s.config.baseUrl+"/course_351845_drill_4141433")).rejects.toThrow("private");expect(s.calls).toHaveLength(0);
 }finally{s.clean();}}
});
test("concurrent commands reserve exclusively before the single POST",async()=>{
 const s=await setup();try{
 const results=await Promise.allSettled([s.client.drills.start("351845","4141433",s.config.baseUrl+"/course_351845_drill_4141433"),s.client.drills.start("351845","4141433",s.config.baseUrl+"/course_351845_drill_4141433")]);
 expect(results.filter(r=>r.status==="fulfilled")).toHaveLength(1);expect(s.calls.filter(c=>c.init?.method==="POST")).toHaveLength(1);
 }finally{s.clean();}
});
test("start requires exact confirmation before auth or network",async()=>{
 const s=await setup();try {for(const confirm of [undefined,"wrong",s.config.baseUrl+"/course_351845_drill_4141433?start=1"]){await expect(s.client.drills.start("351845","4141433",confirm)).rejects.toThrow("confirmation");}expect(s.calls).toHaveLength(0);expect(s.reads()).toBe(0);}finally{s.clean();}
});
