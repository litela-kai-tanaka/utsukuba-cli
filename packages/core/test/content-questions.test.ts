import { expect, test } from "bun:test";
import { ContentUseCases, type AuthUseCases } from "../src/application/manaba-client";
import { ManabaHttpClient } from "../src/infrastructure/http-client";
import { loadConfig } from "../src/infrastructure/config";

const config = loadConfig({ baseUrl: "https://manaba.example/ct", homeDir: "/tmp/synthetic-questions" });
export const fixture = `<main><form method="post"><input type="hidden" name="csrf" value="PRIVATE_TOKEN">
${Array.from({length:20}, (_,i) => `<div class="querypaper articlebody"><p>Question ${i+1}: choose a safe action.</p><strong class="query_required_marker">選択必須</strong><ol class="queryselection required" id="qid${i+1}">${[1,2,3,4].map(n=>`<li><input type="radio" name="qid${i+1}" value="${n}" ${n===2?'checked':''}>Option ${n}</li>`).join('')}</ol><div class="feedback">Prior answer: PRIVATE_FEEDBACK</div></div>`).join('')}
<button>Submit</button></form></main>`;
function setup(html = fixture, status = 200) {
  const calls: RequestInit[] = [];
  const http = new ManabaHttpClient(config, { fetch: async (_,init) => { calls.push(init!); return new Response(html,{status,headers:status===302?{location:"/ct/start"}:undefined}); } });
  const auth = { requireProfile: async () => ({cookies:[]}) } as unknown as AuthUseCases;
  return { client: new ContentUseCases(config,http,auth), calls };
}

test("shared querypaper keeps prompt boundaries and required markers separate", async () => {
  const html = `<div class="querypaper articlebody">${[1,2].map(n=>`<h1>Chapter</h1><br><p>Prompt ${n}<strong class="query_required_marker">選択必須</strong></p><ol class="queryselection required" id="qid${n}"><li><input type="radio" name="qid${n}" value="1">Choice ${n}</li></ol>`).join('')}</div>`;
  const result = await setup(html).client.questions("page_1");
  expect(result.questions.map(q=>q.prompt)).toEqual(["Prompt 1","Prompt 2"]);
});

test("questions extracts all 20 independent prompts and options without historical selections", async () => {
  const {client,calls} = setup();
  const result = await client.questions("course_42_drill_7_submitlog_123");
  expect(result.questions).toHaveLength(20);
  expect(result.questions[0]).toEqual({ questionId:"qid1",type:"radio",required:true,prompt:"Question 1: choose a safe action.",options:[1,2,3,4].map(n=>({optionId:String(n),text:`Option ${n}`})) });
  expect(result.questions[19].prompt).toBe("Question 20: choose a safe action.");
  expect(JSON.stringify(result)).not.toMatch(/checked|selected|PRIVATE|feedback/i);
  expect(calls).toHaveLength(1);
  expect(calls[0].redirect).toBe("manual");
  expect(calls[0].method ?? "GET").toBe("GET");
});

for (const html of [
  '<fieldset><legend>Essay</legend><textarea name="qid1">PRIVATE</textarea></fieldset>',
  '<div class="querypaper"><p>Essay</p><input name="qid1" value="PRIVATE"></div>',
  '<fieldset><legend>Select</legend><select name="qid1"><option>One</option></select></fieldset>',
  '<p>No supported questions</p>',
  '<fieldset><legend>Mixed</legend><label><input type="radio" name="q" value="1">One</label><label><input type="checkbox" name="q" value="2">Two</label></fieldset>',
  '<fieldset><legend>Duplicate</legend><label><input type="radio" name="q" value="1">One</label><label><input type="radio" name="q" value="1">Two</label></fieldset>',
  '<input type="radio" name="qid1" value="1">Unbounded prompt',
]) test("rejects unsupported or ambiguous question layouts with generic error", async()=>{
  await expect(setup(html).client.questions("page_1")).rejects.toThrow("Unsupported or ambiguous question layout");
});

test("standalone queryselection with a required textarea rejects questions and answerPlan", async()=>{
  const html = `<p>Choose an option and explain.</p><ol class="queryselection required"><li><input type="radio" name="q" value="1">One</li><li><input type="radio" name="q" value="2">Two</li><li><textarea name="explanation" required>PRIVATE_ANSWER</textarea></li></ol>`;
  const {client} = setup(html);
  await expect(client.questions("page_1")).rejects.toThrow("Unsupported or ambiguous question layout");
  await expect(client.answerPlan("page_1",{answers:[{questionId:"q",optionIds:["1"],reason:"Synthetic reason"}]})).rejects.toThrow("Unsupported or ambiguous question layout");
});

test("secret controls and repeated values never leak into questions", async()=>{
  const html = `<input type="hidden" name="csrf" value="PRIVATE_SECRET"><input type="password" value="pin"><input type="radio" name="sessionToken" value="SESSION_SECRET"><fieldset><legend>Prompt PRIVATE_SECRET pin</legend><label><input type="checkbox" name="q" value="a" checked>Alpha PRIVATE_SECRET pin</label><label><input type="checkbox" name="q" value="b">Beta</label></fieldset>`;
  const result = await setup(html).client.questions("page_1");
  expect(result.questions).toHaveLength(1);
  expect(result.questions[0].type).toBe("checkbox");
  expect(JSON.stringify(result)).not.toMatch(/PRIVATE|SECRET|pin|checked|session/);
});

test("graded score displays are ignored but real text questions are unsupported", async()=>{
  const html = fixture.replace('<p>Question 1:', '<span class="pointform"><input class="point" type="text" value="PRIVATE_SCORE"></span><p>Question 1:');
  expect((await setup(html).client.questions("page_1")).questions).toHaveLength(20);
});
test("sensitive select option values are redacted from repeated question text", async()=>{
  const html = fixture.replace('<main>', '<main><select name="csrf"><option value="SYNTH_TOKEN">Placeholder</option></select>').replace('Question 1:', 'SYNTH_TOKEN Question 1:');
  expect(JSON.stringify(await setup(html).client.questions("page_1"))).not.toContain("SYNTH_TOKEN");
});
test("answerPlan validates locally with exactly one passive GET",async()=>{
  const {client,calls} = setup();
  const result = await client.answerPlan("page_1",{answers:Array.from({length:20},(_,i)=>({questionId:`qid${i+1}`,optionIds:["1"],reason:"Synthetic reason"}))});
  expect(result.valid).toBe(true);
  expect(result.answers).toHaveLength(20);
  expect(result.submitted).toBe(false);
  expect(calls).toHaveLength(1);
});

test("question reads reject unsafe URLs before GET and do not follow redirects",async()=>{
  const {client,calls}=setup(fixture,302);
  await expect(client.questions("page_1?start=1")).rejects.toThrow("allowed read-only");
  expect(calls).toHaveLength(0);
  await expect(client.questions("page_1")).rejects.toThrow("GET failed");
  expect(calls).toHaveLength(1);
});
