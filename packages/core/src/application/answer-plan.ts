import type { ContentQuestions } from "../infrastructure/content-questions";

export type AnswerDraft = { answers: { questionId: string; optionIds: string[]; reason: string }[] };

/** Exact JSON schema; never include input, filenames or parser details in errors. */
export function parseAnswerDraft(input: unknown): AnswerDraft {
  const fail = () => new Error("Invalid answer draft: check the exact schema, IDs, coverage and selection counts.");
  const exactObject = (value: unknown, keys: string[]): value is Record<string, unknown> => {
    if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) return false;
    const own = Reflect.ownKeys(value);
    return own.length === keys.length && own.every(k=>typeof k === "string" && keys.includes(k) && "value" in Object.getOwnPropertyDescriptor(value,k)!);
  };
  if (!exactObject(input,["answers"]) || !Array.isArray(input.answers)) throw fail();
  for (const entry of input.answers) {
    if (!exactObject(entry,["questionId","optionIds","reason"]) || typeof entry.questionId !== "string" || !Array.isArray(entry.optionIds) || entry.optionIds.some(id=>typeof id !== "string") || typeof entry.reason !== "string" || !entry.reason.trim()) throw fail();
  }
  return input as AnswerDraft;
}

export function validateAnswerPlan(content: ContentQuestions, input: unknown) {
  const draft = parseAnswerDraft(input);
  const fail = () => new Error("Invalid answer draft: check the exact schema, IDs, coverage and selection counts.");
  if (!content.questions.length || draft.answers.length !== content.questions.length) throw fail();
  const seen = new Set<string>();
  const answers = draft.answers.map(answer=>{
    const question = content.questions.find(q=>q.questionId===answer.questionId);
    if (!question || seen.has(answer.questionId) || new Set(answer.optionIds).size !== answer.optionIds.length || answer.optionIds.some(id=>!question.options.some(o=>o.optionId===id)) || (question.type === "radio" && answer.optionIds.length !== 1) || (question.required && !answer.optionIds.length)) throw fail();
    seen.add(answer.questionId);
    return {questionId:answer.questionId,options:question.options.filter(o=>answer.optionIds.includes(o.optionId)),reason:answer.reason};
  });
  return {url:content.url,valid:true as const,mode:"draft" as const,submitted:false as const,answers};
}
