import { expect, test } from "bun:test";
import { ContentUseCases, type AuthUseCases } from "../src/application/manaba-client";
import { ManabaHttpClient } from "../src/infrastructure/http-client";
import { loadConfig } from "../src/infrastructure/config";

const config = loadConfig({ baseUrl: "https://manaba.example/ct", homeDir: "/tmp/synthetic-manaba-inspect" });
const fixture = `<!doctype html><nav>Site navigation</nav><main>
<h1>Synthetic lesson</h1><p>Read this lesson.</p><p>Then review.</p>
<a href="./course_42_drill_7">Review test</a>
<a href="https://lesson.example/book?token=URL_SECRET#private">Textbook</a>
<iframe src="./lesson.html?sid=FRAME_SECRET"></iframe><embed src="./slides.pdf"><object data="./book.pdf"></object>
<form action="./start?token=ACTION_SECRET" method="post">
<input type="hidden" name="csrf" value="HIDDEN_SECRET">
<label for="answer">Your answer</label><input id="answer" name="answer" value="ANSWER_SECRET">
<label>Choice<select name="choice"><option value="OPTION_SECRET">One</option><option>Two</option></select></label>
<label>Password<input type="password" name="password" value="PASSWORD_SECRET"></label>
<textarea name="notes">TEXTAREA_SECRET</textarea><button name="start" value="BUTTON_SECRET">Start</button>
</form><script>JS_SECRET</script><style>CSS_SECRET</style><p hidden>HIDDEN_TEXT</p>
</main><footer>Site footer</footer>`;

function setup(html = fixture, status = 200, headers?: HeadersInit) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const http = new ManabaHttpClient(config, { fetch: async (input, init) => {
    calls.push({ url: String(input), init });
    return new Response(html, { status, headers });
  } });
  const auth = { requireProfile: async () => ({ cookies: [{ name: "session", value: "COOKIE_SECRET" }] }) } as AuthUseCases;
  return { client: new ContentUseCases(config, http, auth), calls };
}

test("inspect returns main text, observed resources and value-free form controls using one GET", async () => {
  const { client, calls } = setup();
  const result = await client.inspect("page_12c42");
  expect(result.text).toContain("Read this lesson.\nThen review.");
  expect(result.text).not.toContain("Site navigation");
  expect(result.text).not.toContain("Site footer");
  expect(result.links).toContainEqual({ text: "Review test", url: "https://manaba.example/ct/course_42_drill_7" });
  expect(result.links).toContainEqual({ text: "Textbook", url: "https://lesson.example/book" });
  expect(result.resources).toEqual([
    { type: "iframe", url: "https://manaba.example/ct/lesson.html" },
    { type: "embed", url: "https://manaba.example/ct/slides.pdf" },
    { type: "object", url: "https://manaba.example/ct/book.pdf" },
  ]);
  expect(result.forms[0].controls).toContainEqual({ type: "text", name: "answer", label: "Your answer" });
  expect(result.forms[0].controls).toContainEqual({ type: "select", name: "choice", label: "Choice", options: ["One", "Two"] });
  expect(JSON.stringify(result)).not.toMatch(/SECRET|HIDDEN_TEXT/);
  expect(calls).toHaveLength(1);
  expect(calls[0].url).toBe("https://manaba.example/ct/page_12c42");
  expect(calls[0].init?.method ?? "GET").toBe("GET");
  expect(calls[0].init?.redirect).toBe("manual");
  expect(new Headers(calls[0].init?.headers).get("cookie")).toBe("session=COOKIE_SECRET");
});


test("inspect isolates legacy Manaba article content and excludes calendars", async () => {
  const { client } = setup(`<div class="contents"><aside>Calendar 1 2 3</aside><div class="articlebody"><div class="articletext"><h2>Lesson</h2><p>Legacy body</p><a href="./course_42_drill_7">Test</a></div><form><label>Answer<input name="answer"></label></form></div></div>`);
  const result = await client.inspect("page_12c42");
  expect(result.text).toBe("Lesson\nLegacy body\nTest\nAnswer");
  expect(result.forms[0].controls[0].label).toBe("Answer");
});

for (const target of [
  "https://evil.example/ct/page_1", "//evil.example/ct/page_1",
  "https://manaba.example.evil/ct/page_1", "http://manaba.example/ct/page_1",
  "https://user:pass@manaba.example/ct/page_1", "/outside/page_1", "/ctevil/page_1",
  "../page_1", "/ct/%2e%2e/page_1", "/ct/%70age_1", "\\evil.example/ct/page_1",
  "page_1?action=start", "course_42_drill_7?start=1", "course_42_drill_7_start", "course_42_drill_7_answer",
  "course_42_query_7", "logout", "", " page_1", "page_1#secret", "javascript:alert(1)",
]) {
  test(`inspect rejects unsafe target before fetching: ${target}`, async () => {
    const { client, calls } = setup();
    await expect(client.inspect(target)).rejects.toThrow("allowed read-only");
    expect(calls).toHaveLength(0);
  });
}

for (const target of ["page_12c42", "/ct/page_12c42", "https://manaba.example/ct/page_12c42", "./course_42_drill_7"]) {
  test(`inspect allows passive route: ${target}`, async () => {
    const { client, calls } = setup();
    await client.inspect(target);
    expect(calls).toHaveLength(1);
  });
}

for (const location of ["https://evil.example/steal", "/ct/page_13", "/ct/login"]) {
  test(`inspect never follows redirect: ${location}`, async () => {
    const { client, calls } = setup("BODY_SECRET", 302, { location });
    await expect(client.inspect("page_12c42")).rejects.toThrow("GET failed");
    expect(calls).toHaveLength(1);
  });
}

test("inspect removes form secrets from repeated text, links and option labels", async () => {
  const { client } = setup(`<main><input type="HIDDEN" value="REPEATED_SECRET"><p>REPEATED_SECRET</p><a href="https://u:pass@external.example/book?x=REPEATED_SECRET#secret">REPEATED_SECRET</a><iframe src="javascript:alert(1)"></iframe><embed src="data:text/html,SECRET"><form><select name="choice"><option value="VALUE_SECRET">REPEATED_SECRET</option></select><input name="sessionToken" value="SESSION_SECRET"></form><div style="display:none">INVISIBLE_SECRET</div></main>`);
  const result = await client.inspect("page_12c42");
  expect(JSON.stringify(result)).not.toMatch(/SECRET|u:pass/);
  expect(result.resources).toEqual([]);
  expect(result.links[0].url).toBe("https://external.example/book");
});


test("inspect redacts short password values with non-sensitive names everywhere", async () => {
  const { client } = setup(`<main><input type="password" name="pin" value="abc123"><p>Code: abc123</p><a href="https://external.example/abc123">abc123</a><form><label for="answer">abc123</label><input id="answer" name="answer"></form></main>`);
  const result = await client.inspect("page_12c42");
  expect(JSON.stringify(result)).not.toContain("abc123");
  expect(result.text).toContain("Code: [redacted]");
  expect(result.links[0]).toEqual({ text: "[redacted]", url: "https://external.example/[redacted]" });
  expect(result.forms[0].controls[0].label).toBe("[redacted]");
});

 test("benign hidden flags do not corrupt lesson numbers or resource paths", async () => {
  const { client } = setup(`<main><input type="hidden" name="flag" value="1"><input type="hidden" name="csrf" value="CSRF_SECRET"><p>Lesson 1 of 5. CSRF_SECRET</p><a href="./course_421_drill_17">Test 1</a></main>`);
  const result = await client.inspect("page_12c42");
  expect(result.text).toBe("Lesson 1 of 5. [redacted]\nTest 1");
  expect(result.links[0].url).toBe("https://manaba.example/ct/course_421_drill_17");
  expect(JSON.stringify(result)).not.toContain("CSRF_SECRET");
});


test("inspect allows observed passive submission logs but rejects attempt routes", async () => {
  const { client, calls } = setup();
  await client.inspect("course_42_drill_7_submitlog_123");
  expect(calls[0].url).toBe("https://manaba.example/ct/course_42_drill_7_submitlog_123");
  for (const path of ["course_42_drill_7_submitlog", "course_42_drill_7_submitlog_123_answer", "course_42_drill_7_submitlog_123?start=1"]) {
    await expect(client.inspect(path)).rejects.toThrow("allowed read-only");
  }
  expect(calls).toHaveLength(1);
});

test("secret redaction precedes whitespace normalization and line splitting", async () => {
  const { client } = setup(`<main><input type="password" name="password" value="synthetic  password"><input type="hidden" name="csrf" value="multi\nline secret"><p>synthetic  password</p><p>multi\nline secret</p><form><label for="answer">synthetic password</label><input id="answer" name="answer"></form></main>`);
  const result = await client.inspect("page_12c42");
  expect(JSON.stringify(result)).not.toMatch(/synthetic|password|multi|line secret/);
  expect(result.text).toContain("[redacted]");
  expect(result.forms[0].controls[0].label).toBe("[redacted]");
});


test("short passwords are still scrubbed from repeated body text", async () => {
  const { client } = setup(`<main><input type="password" value="abc"><p>abc</p></main>`);
  expect((await client.inspect("page_12c42")).text).toBe("[redacted]");
});

test("inspection validates before session reads and never leaks auth-store errors", async () => {
  let reads = 0;
  const auth = { requireProfile: async () => { reads++; throw new Error("AUTH_STORE_SECRET"); } } as unknown as AuthUseCases;
  const client = new ContentUseCases(config, new ManabaHttpClient(config, { fetch: async () => { throw new Error("FETCH_SECRET"); } }), auth);
  await expect(client.inspect("https://evil.example/ct/page_1")).rejects.toThrow("allowed read-only");
  expect(reads).toBe(0);
  await expect(client.inspect("page_12c42")).rejects.toThrow("GET failed");
  expect(reads).toBe(1);
});
