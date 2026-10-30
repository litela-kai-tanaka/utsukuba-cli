import { test, expect } from 'bun:test';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setup, form, question, next, final, draft } from './drill-flow-fixture';
// Explicitly synthetic forms: no provider final action names are assumed.
for (const action of ['https://evil.test/ct/course_351845_drill_4141433_queryshow','course_351845_drill_4141433_restart','course_351845_drill_99_queryshow','course_351845_drill_4141433_queryshow?logout=1','course_351845_drill_4141433_queryshow#fragment']) test('step rejects unsafe/cross-target form action '+action,async()=>{
 const s=await setup({questionHtml:form(question+`<button name="${next}">次へ</button>`,action)});try{await s.start();await s.open();await expect(s.step()).rejects.toThrow();expect(s.calls.filter(c=>c.method==='POST')).toHaveLength(1);}finally{s.clean();}
});
for (const location of ['https://evil.test/ct/course_351845_drill_4141433_queryshow','/ct/course_351845_drill_4141433_queryshow?logout=1','/ct/course_351845_drill_4141433_queryshow?refresh=x&refresh=y','/ct/course_351845_drill_4141433_restart']) test('open rejects saved unsafe Location without following it '+location,async()=>{
 const s=await setup({location});try{await s.start();const before=s.calls.length;await expect(s.open()).rejects.toThrow();expect(s.calls.length).toBe(before);}finally{s.clean();}
});
test('confirmation, operation and pause/unknown/submit control guards prevent all writes',async()=>{
 const s=await setup();try{await s.start();await s.open();for(const args of [['next',next,draft,'wrong'],['pause',next,draft,s.url],['submit',next,undefined,s.url],['next','action_DrillStudent_pause',draft,s.url],['next','action_DrillStudent_invented',draft,s.url]] as [string,string,unknown,string][])await expect(s.step(...args)).rejects.toThrow();expect(s.calls.filter(c=>c.method==='POST')).toHaveLength(1);}finally{s.clean();}
});
test('current question binding and hidden/auth override drafts reject before baseline and POST',async()=>{
 const s=await setup();try{await s.start();await s.open();const before=s.calls.length;for (const answers of [{answers:[]},{answers:[{questionId:'qid1',optionIds:['3'],reason:'old'}]},{answers:[{questionId:'SessionValue',optionIds:['a'],reason:'override'}]},{...draft,SessionValue:'override'}])await expect(s.step('next',next,answers)).rejects.toThrow();expect(s.calls.length).toBe(before);}finally{s.clean();}
});
test('concurrent same-state steps reserve one answer POST',async()=>{
 const s=await setup();try{await s.start();await s.open();const outcomes=await Promise.allSettled([s.step(),s.step()]);expect(outcomes.filter(x=>x.status==='fulfilled')).toHaveLength(1);expect(s.calls.filter(c=>c.method==='POST')).toHaveLength(2);}finally{s.clean();}
});
test('validated answer response digest prevents tampered confirmation replay',async()=>{
 const s=await setup();try{const start=await s.start();await s.open();await s.step();const journal=JSON.parse(readFileSync(start.stateFile,'utf8'));journal.rawBody+=' changed';writeFileSync(start.stateFile,JSON.stringify(journal));await expect(s.step('submit',final)).rejects.toThrow();expect(s.calls.filter(c=>c.method==='POST')).toHaveLength(2);}finally{s.clean();}
});
test('short sensitive numeric token redacts even though benign hidden flag remains usable',async()=>{
 const s=await setup({questionHtml:form(question+`<button name="${next}">次へ</button>`).replace('value="xy"','value="7"').replace('Current question 1','Current question 1: secret 7')});try{await s.start();const opened=await s.open();expect(JSON.stringify(opened)).not.toContain('secret 7');expect(opened.questions?.questions[0].options[0].optionId).toBe('1');}finally{s.clean();}
});
test('submission response does not become submitted without independently graded new record',async()=>{
 const s=await setup({ungraded:true});try{await s.start();await s.open();await s.step();await s.step('submit',final);expect((await s.client.drills.verify('351845','4141433')).submitted).toBe(false);}finally{s.clean();}
});
test('network timeout after answer POST leaves unknown durable stage blocking all subsequent effects',async()=>{
 const s=await setup({transportUnknown:true});try{await s.start();await s.open();const result=await s.step();expect(result.stage).toBe('unknown');await expect(s.step()).rejects.toThrow();await expect(s.step('submit',final)).rejects.toThrow();expect(s.calls.filter(c=>c.method==='POST')).toHaveLength(2);}finally{s.clean();}
});
test('new graded querystatus log permits question prose mentioning ログイン',async()=>{
 const s=await setup({mentionsLogin:true});try{await s.start();await s.open();await s.step();await s.step('submit',final);expect((await s.client.drills.verify('351845','4141433')).submitted).toBe(true);}finally{s.clean();}
});
test('form wrapping article exposes only validated exact submit control metadata from full page',async()=>{
 const s=await setup({questionHtml:form(`<div class="articletext querypaper">${question}</div><button name="${next}">次へ</button>`)});try{await s.start();const result=await s.open();expect(result.observedControls).toContainEqual({name:next,label:'次へ',operation:'next',actionPath:'/ct/course_351845_drill_4141433_queryshow'});}finally{s.clean();}
});
test('manual next redirect opens saved confirmation once then permits final submit',async()=>{
 const s=await setup({redirectNext:true});try{await s.start();await s.open();await s.step();await expect(s.step('submit',final)).rejects.toThrow();const opened=await s.open();expect(opened.observedControls.some(c=>c.name===final)).toBe(true);await s.step('submit',final);expect((await s.client.drills.verify('351845','4141433')).submitted).toBe(true);}finally{s.clean();}
});
test('saved private archives preserve pre-open redirect and response history',async()=>{
 const s=await setup();try{const start=await s.start();await s.open();await s.step();const files=readdirSync(join(start.stateFile,'..')).filter(f=>/^state-.*\.json$/.test(f));expect(files.length).toBeGreaterThan(2);expect(files.some(f=>readFileSync(join(start.stateFile,'..',f),'utf8').includes('PRIVATE_REFRESH'))).toBe(true);}finally{s.clean();}
});
