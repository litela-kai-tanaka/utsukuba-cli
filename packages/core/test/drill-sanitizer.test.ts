import { test, expect } from 'bun:test';
import { parseContentQuestions } from '../src/infrastructure/content-questions';
import { parseContentInspection } from '../src/infrastructure/content-inspection';
const html = `<main><form><input type="hidden" name="manaba-form" value="1"><input type="hidden" name="SessionValue" value="xy"><input type="password" value="zz"><fieldset><legend>Question 1 xy zz</legend><label><input type="radio" name="qid1" value="1">Choice 1 xy zz</label></fieldset><input type="submit" name="action_DrillStudent_next_queryshow" value="次へ"></form></main>`;
test('benign numeric hidden flag leaves option IDs intact; short session/password values stay redacted', () => {
 const parsed = parseContentQuestions(html, 'https://example.test/ct/page_1');
 expect(parsed.questions[0].options[0].optionId).toBe('1');
 expect(parsed.questions[0].questionId).toBe('qid1');
 expect(JSON.stringify(parsed)).not.toMatch(/xy|zz/);
 expect(parseContentInspection(html,'https://example.test/ct/page_1').forms[0].controls.at(-1)?.label).toBe('次へ');
});
