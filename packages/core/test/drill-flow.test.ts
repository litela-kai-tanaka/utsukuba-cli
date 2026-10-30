import { test, expect } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createManabaClient } from '../src/application/manaba-client';
import { AuthStore } from '../src/infrastructure/auth-store';
import { loadConfig } from '../src/infrastructure/config';
const stem='course_351845_drill_4141433';
const next='action_DrillStudent_next_queryshow';
// These final action/route names are SYNTHETIC, not claimed provider names.
const final='action_DrillStudent_synthetic_final';
const hidden='<input type="hidden" name="manaba-form" value="1"><input type="hidden" name="SessionValue" value="xy"><input type="hidden" name="SessionValue1" value="SYNTH_PRIVATE_TOKEN">';
const rows='<table><tr><th>状態</th><td>受付中</td></tr><tr><th>提出上限</th><td>無制限</td></tr><tr><th>受付終了日時</th><td>未設定</td></tr></table>';
const form=(body:string, action=stem+'_queryshow')=>`<main><form method="post" action="${action}">${hidden}${body}</form></main>`;
const question='<fieldset required><legend>Current question 1</legend><label><input required type="radio" name="qid1" value="1">First</label><label><input type="radio" name="qid1" value="2">Second</label></fieldset>';
const draft={answers:[{questionId:'qid1',optionIds:['2'],reason:'Synthetic selection'}]};
async function setup(options:{questionHtml?:string;location?:string;timeout?:boolean;oldOnly?:boolean}={}) {
 const home=mkdtempSync(join(tmpdir(),'synthetic-drill-flow-'));const calls:{method:string;url:string;body:URLSearchParams}[]=[];let completed=false;
 const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(req){
  const url=new URL(req.url);const body=new URLSearchParams(req.method==='POST'?await req.text():'');calls.push({method:req.method,url:req.url,body});
  if(req.method==='POST') {
   if(body.has('action_DrillStudent_querystart'))return new Response('',{status:302,headers:{location:options.location??`/ct/${stem}_queryshow?refresh=PRIVATE_REFRESH`}});
   if(body.has(next)){if(options.timeout)throw new Error('synthetic failure');return new Response(form(`<input type="submit" name="${final}" value="提出">`));}
   if(body.has(final)){completed=true;return new Response('受領',{status:302,headers:{location:`/ct/${stem}_result`}});}
   return new Response('unknown',{status:400});
  }
  if(url.pathname.endsWith('_queryshow'))return new Response(options.questionHtml??form(question+`<input type="submit" name="${next}" value="次へ"><input type="submit" name="action_DrillStudent_pause" value="中断（一時保存）">`));
  if(url.pathname.includes('_submitlog_'))return new Response('<main><table><tr><th>得点</th><td>100</td></tr></table></main>');
  return new Response(`<main>${rows}<a href="${stem}_submitlog_10">過去の履歴</a>${completed&&!options.oldOnly?`<a href="${stem}_submitlog_11">新しい履歴</a>`:''}<form method="post" action="${stem}">${hidden}<input type="submit" name="action_DrillStudent_querystart" value="受験開始"></form></main>`);
 }});
 const base=`http://127.0.0.1:${server.port}/ct`;const config=loadConfig({homeDir:home,baseUrl:base});const store=new AuthStore(config);await store.save({profile:config.profile,baseUrl:base,cookies:[],credentialStored:false,savedAt:'synthetic'});const client=createManabaClient(config);const url=base+'/'+stem;
 return {home,client,calls,url,clean(){server.stop(true);rmSync(home,{recursive:true,force:true});},async start(){return client.drills.start('351845','4141433',url);},async open(){return client.drills.openAttempt('351845','4141433');},async step(operation='next',control=next,answers:unknown=operation==='next'?draft:undefined,confirmTarget=url){return client.drills.step('351845','4141433',{operation,control,answers,confirmTarget});}};
}
test('synthetic complete start -> GET queryshow -> validated next -> observed confirmation -> final -> new graded history',async()=>{
 const s=await setup();try{
 const started=await s.start();const opened=await s.open();expect(opened.questions?.questions[0].questionId).toBe('qid1');expect(JSON.stringify(opened)).not.toMatch(/PRIVATE|xy|SessionValue/);
 await expect(s.open()).rejects.toThrow();
 const result=await s.step();expect(result.stage).toBe('response-saved');expect(result.submitted).toBe(false);
 const nextPost=s.calls.filter(c=>c.method==='POST')[1];expect([...nextPost.body.keys()].filter(k=>k.startsWith('action_'))).toEqual([next]);expect(nextPost.body.get('qid1')).toBe('2');expect(nextPost.body.get('SessionValue')).toBe('xy');
 const state=JSON.parse(readFileSync(started.stateFile,'utf8'));expect(state.answerPlan.valid).toBe(true);expect(state.baselineLogIds).toEqual(['10']);expect(state.questionDigest).toBeTruthy();expect(statSync(started.stateFile).mode&0o777).toBe(0o600);
 await expect(s.step()).rejects.toThrow();
 const inspected=await s.client.drills.inspectAttempt('351845','4141433');expect(JSON.stringify(inspected)).toContain(final);
 expect((await s.step('submit',final,undefined)).submitted).toBe(false);
 await expect(s.step('submit',final,undefined)).rejects.toThrow();
 expect(await s.client.drills.verify('351845','4141433')).toMatchObject({submitted:true,newLogIds:['11']});
 }finally{s.clean();}
});
test('old graded history cannot verify a new submission',async()=>{
 const s=await setup({oldOnly:true});try{await s.start();await s.open();await s.step();await s.step('submit',final,undefined);expect((await s.client.drills.verify('351845','4141433')).submitted).toBe(false);}finally{s.clean();}
});
