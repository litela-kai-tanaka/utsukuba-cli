import { expect, test } from "bun:test";

test("utsukuba exposes manaba subcommands for namespaced login", async () => {
  const proc = Bun.spawn({
    cmd: ["bun", "packages/cli/src/index.ts", "manaba", "login", "--help"],
    cwd: `${import.meta.dir}/../../..`,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
  expect(stdout).toContain("Usage: utsukuba manaba login");
  expect(stdout).toContain("--username");
});


for (const prefix of [[], ["manaba"]]) {
  for (const command of ["questions","answer-plan"]) test(`draft command exposed ${prefix.join(" ")} ${command}`,async()=>{
    const proc = Bun.spawn({cmd:["bun","packages/cli/src/index.ts",...prefix,"contents",command,"--help"],cwd:`${import.meta.dir}/../../..`,stdout:"pipe",stderr:"pipe"});
    const stdout=await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    expect(stdout).toContain(`contents ${command} [options] <pageUrlOrId>`);
    if(command==="answer-plan") expect(stdout).toContain("--answers");
  });
  test(`contents inspect is exposed ${prefix.join(" ")}`, async () => {
    const proc = Bun.spawn({ cmd: ["bun", "packages/cli/src/index.ts", ...prefix, "contents", "inspect", "--help"], cwd: `${import.meta.dir}/../../..`, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
    expect(stdout).toContain("contents inspect [options] <pageUrlOrId>");
    expect(stdout).toContain("read-only");
  }, 30_000);
}


test("CLI inspection emits structured JSON via authenticated GET without following resources", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const home = mkdtempSync(join(tmpdir(), "synthetic-inspect-cli-"));
  const calls: { method: string; path: string; cookie: string | null }[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    calls.push({ method: request.method, path: new URL(request.url).pathname, cookie: request.headers.get("cookie") });
    return new Response(`<main><h1>Fixture lesson</h1><p>Lesson body</p><a href="https://external.example/book?token=URL_SECRET">Book</a><iframe src="/ct/embedded"></iframe><form method="post"><input type="hidden" value="HIDDEN_SECRET"><label>Choice<input name="choice" value="VALUE_SECRET"></label><button>Start</button></form></main>`, { headers: { "content-type": "text/html" } });
  } });
  try {
    const dir = join(home, "profiles", "default", "manaba");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "auth.json"), JSON.stringify({ profile: "default", baseUrl: `http://127.0.0.1:${server.port}/ct`, cookies: [{ name: "session", value: "COOKIE_SECRET" }], credentialStored: false, savedAt: new Date().toISOString() }));
    const proc = Bun.spawn({ cmd: ["bun", "packages/cli/src/index.ts", "--base-url", `http://127.0.0.1:${server.port}/ct`, "--json", "contents", "inspect", "page_12c42"], cwd: `${import.meta.dir}/../../..`, env: { ...process.env, UTSUKUBA_CLI_HOME: home }, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
    const result = JSON.parse(stdout);
    expect(result.text).toContain("Lesson body");
    expect(result.links[0]).toEqual({ text: "Book", url: "https://external.example/book" });
    expect(result.resources[0].type).toBe("iframe");
    expect(result.forms[0].controls[0]).toEqual({ type: "text", name: "choice", label: "Choice" });
    expect(stdout).not.toContain("SECRET");
    expect(calls).toEqual([{ method: "GET", path: "/ct/page_12c42", cookie: "session=COOKIE_SECRET" }]);
  } finally {
    server.stop(true);
    rmSync(home, { recursive: true, force: true });
  }
}, 30_000);
