import { expect, test } from "bun:test";
import * as drafts from "../src/application/answer-plan";
import type { ContentQuestions } from "../src/infrastructure/content-questions";
const invalid = () => [null, [], {}, {answers:[]}, {answers:[null]}, {answers:[{questionId:"qid1",optionIds:["1"],reason:7}]}, {answers:[{questionId:"qid1",optionIds:["1"],reason:""}]}, {answers:[{questionId:"qid1",optionIds:["1"],reason:"r",secret:"PRIVATE"}]}, JSON.parse('{"__proto__":{},"answers":[]}'), {answers:[{questionId:"unknown_PRIVATE",optionIds:["1"],reason:"r"}]}, {answers:[{questionId:"qid1",optionIds:["3"],reason:"r"}]}, {answers:[{questionId:"qid1",optionIds:[],reason:"r"}]}, {answers:[{questionId:"qid1",optionIds:["1","2"],reason:"r"}]}, {answers:[{questionId:"qid1",optionIds:["1","1"],reason:"r"}]}, {answers:[{questionId:"qid1",optionIds:["1"],reason:"r"},{questionId:"qid1",optionIds:["1"],reason:"r"}]}];
const questions: ContentQuestions = {url:"https://manaba.example/ct/page_1",questions:[{questionId:"qid1",type:"radio",required:true,prompt:"Choose",options:[{optionId:"1",text:"Alpha"},{optionId:"2",text:"Beta"}]}]};
for (const input of invalid()) test("invalid answer draft fails with generic non-echoing errors",()=>{
  expect(()=>drafts.validateAnswerPlan(questions,input)).toThrow("Invalid answer draft");
});
test("prototype objects and extra keys are rejected",()=>{
  expect(()=>drafts.validateAnswerPlan(questions,Object.create({answers:[]}))).toThrow("Invalid answer draft");
});
test("checkboxes allow multiple choices; full coverage includes optional questions",()=>{
  const checkbox: ContentQuestions = {...questions,questions:[{...questions.questions[0],type:"checkbox"}]};
  expect(drafts.validateAnswerPlan(checkbox,{answers:[{questionId:"qid1",optionIds:["1","2"],reason:"r"}]}).answers[0].options).toHaveLength(2);
  expect(()=>drafts.validateAnswerPlan({...checkbox,questions:[{...checkbox.questions[0],required:false}]},{answers:[]})).toThrow("Invalid answer draft");
});
test("validated drafts return chosen text, reasons, and never claim submission or grading",()=>{
  expect(drafts.validateAnswerPlan(questions,{answers:[{questionId:"qid1",optionIds:["2"],reason:"Because Beta"}]})).toEqual({url:questions.url,valid:true,mode:"draft",submitted:false,answers:[{questionId:"qid1",options:[{optionId:"2",text:"Beta"}],reason:"Because Beta"}]});
});
