import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createManabaClient } from '../src/application/manaba-client';
import { ManabaHttpClient } from '../src/infrastructure/http-client';
import { AuthStore } from '../src/infrastructure/auth-store';
import { loadServiceConfig } from '../src/infrastructure/config';
const stem='course_351845_drill_4141433';
export const next='action_DrillStudent_next_queryshow';
// Explicitly SYNTHETIC: not an assumed provider final control name.
export const final='action_DrillStudent_synthetic_final';
const hidden='<input type="hidden" name="manaba-form" value="1"><input type="hidden" name="SessionValue" value="xy"><input type="hidden" name="SessionValue1" value="SYNTH_PRIVATE_TOKEN">';
const rows='<table><tr><th>状態</th><td>受付中</td></tr><tr><th>提出上限</th><td>無制限</td></tr><tr><th>受付終了日時</th><td>未設定</td></tr></table>';
export const form=(body:string, action=stem+'_queryshow')=>`<main><form method="post" action="${action}">${hidden}${body}</form></main>`;
export const question='<fieldset required><legend>Current question 1</legend><label><input required type="radio" name="qid1" value="1">First</label><label><input type="radio" name="qid1" value="2">Second</label></fieldset>';
export const draft={answers:[{questionId:'qid1',optionIds:['2'],reason:'Synthetic selection'}]};
export async function setup(options:{questionHtml?:string;location?:string;oldOnly?:boolean;ungraded?:boolean;transportUnknown?:boolean;mentionsLogin?:boolean;redirectNext?:boolean;expired?:boolean}={}) {
 const home=mkdtempSync(join(tmpdir(),'synthetic-drill-flow-'));const calls:{method:string;url:string;body:URLSearchParams}[]=[];let completed=false;let started=false;
 const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(req){
  const url=new URL(req.url);const body=new URLSearchParams(req.method==='POST'?await req.text():'');calls.push({method:req.method,url:req.url,body});
  if(req.method==='POST') {
   if(body.has('action_DrillStudent_querystart')){started=true;return new Response('',{status:302,headers:{location:options.location??`/ct/${stem}_queryshow?refresh=PRIVATE_REFRESH`}});}
   if(body.has(next))return options.redirectNext?new Response('',{status:302,headers:{location:`/ct/${stem}_confirmation?refresh=SYNTH_REFRESH`}}):new Response(form(`<input type="submit" name="${final}" value="提出">`));
   if(body.has(final)){completed=true;return new Response('受領',{status:302,headers:{location:`/ct/${stem}_result`}});}
   return new Response('unknown',{status:400});
  }
  if(url.pathname.endsWith('_confirmation'))return new Response(form(`<input type="submit" name="${final}" value="提出">`));
  if(url.pathname.endsWith('_queryshow'))return new Response(options.questionHtml??form(question+`<input type="submit" name="${next}" value="次へ"><input type="submit" name="action_DrillStudent_pause" value="中断（一時保存）">`));
  if(url.pathname.includes('_submitlog_'))return new Response(options.ungraded?'<main>Pending</main>':options.mentionsLogin?'<main><table><tr><td class="querystatus">採点結果 <span>100</span> 回答数 20 / 20</td></tr></table><div class="querypaper articlebody"><p>毎回ログイン時に確認</p></div></main>':'<main><table><tr><th>得点</th><td>100</td></tr></table></main>');
  return new Response(`<main>${started&&options.expired?rows.replace('受付中','受付終了'):rows}<a href="${stem}_submitlog_10">過去の履歴</a>${completed&&!options.oldOnly?`<a href="${stem}_submitlog_11">新しい履歴</a>`:''}<form method="post" action="${stem}">${hidden}<input type="submit" name="action_DrillStudent_querystart" value="受験開始"></form></main>`);
 }});
 const base=`http://127.0.0.1:${server.port}/ct`;const config=loadServiceConfig('manaba',{homeDir:home,baseUrl:base});const store=new AuthStore(config);await store.save({profile:config.profile,baseUrl:base,cookies:[],credentialStored:false,savedAt:'synthetic'});
 const client=createManabaClient(config,options.transportUnknown?{http:new ManabaHttpClient(config,{fetch:async(input,init)=>{const response=await fetch(input,init);if(init?.method==='POST' && (init.body as URLSearchParams).has(next))throw Error('SYNTH_PRIVATE_TIMEOUT');return response;}})}:{});const url=base+'/'+stem;
 return {home,config,client,calls,url,clean(){server.stop(true);rmSync(home,{recursive:true,force:true});},async start(){return client.drills.start('351845','4141433',url);},async open(){return client.drills.openAttempt('351845','4141433');},async step(operation='next',control=next,answers:unknown=operation==='next'?draft:undefined,confirmTarget=url){return client.drills.step('351845','4141433',{operation,control,answers,confirmTarget});}};
}
