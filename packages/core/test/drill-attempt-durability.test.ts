import { expect, test } from "bun:test";
import { existsSync, fsyncSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DrillUseCases } from "../src/application/drill-attempt";
import { createManabaClient } from "../src/application/manaba-client";
import { AuthStore } from "../src/infrastructure/auth-store";
import { loadConfig } from "../src/infrastructure/config";
import { ManabaHttpClient } from "../src/infrastructure/http-client";

const landing = `<table><tr><th>状態</th><td>受付中</td></tr><tr><th>提出上限</th><td>無制限</td></tr><tr><th>受付終了日時</th><td>未設定</td></tr></table><form method="post" action="course_351845_drill_4141433"><input type="hidden" name="manaba-form" value="synthetic"><input type="hidden" name="SessionValue1" value="synthetic"><input type="hidden" name="SessionValue" value="synthetic"><input type="submit" name="action_DrillStudent_querystart" value="start"></form>`;

async function setup(existingRoot = false, failAt?: "home" | "attempts") {
 const home = mkdtempSync(join(tmpdir(), "synthetic-drill-durability-"));
 const root = join(home, "attempts");
 if (existingRoot) mkdirSync(root, { mode: 0o700 });
 const config = loadConfig({ homeDir: home, baseUrl: "http://127.0.0.1:1234/ct" });
 const store = new AuthStore(config);
 await store.save({ profile: config.profile, baseUrl: config.baseUrl, cookies: [], credentialStored: false, savedAt: "synthetic" });
 const events: string[] = [];
 const http = new ManabaHttpClient(config, { fetch: async (_, init) => {
  if (init?.method === "POST") {
   events.push("POST");
   const state = join(root, readdirSync(root)[0], "state.json");
   expect(JSON.parse(readFileSync(state, "utf8")).stage).toBe("post-pending");
   return new Response("<main>synthetic response</main>");
  }
  events.push("GET");
  return new Response(landing);
 } });
 const sync = (fd: number) => {
  const path = readlinkSync(`/proc/self/fd/${fd}`);
  const name = path === home ? "home" : path === root ? "attempts" : path;
  events.push(name);
  if (name === "attempts") expect(readdirSync(root)).toHaveLength(1);
  if (name === failAt) throw new Error("synthetic fsync failure");
  fsyncSync(fd);
 };
 const client = createManabaClient(config, { http, authStore: store });
 const drills = new DrillUseCases(config, http, client.auth, sync);
 return { home, root, events, start: () => drills.start("351845", "4141433", config.baseUrl + "/course_351845_drill_4141433"), clean: () => rmSync(home, { recursive: true, force: true }) };
}

for (const existingRoot of [false, true]) test(`parent directories are synced before POST (existing attempts: ${existingRoot})`, async () => {
 const s = await setup(existingRoot);
 try {
  expect((await s.start()).stage).toBe("response-saved");
  expect(s.events).toEqual(["home", "GET", "attempts", "POST"]);
 } finally { s.clean(); }
});

for (const failAt of ["home", "attempts"] as const) test(`${failAt} fsync failure blocks POST`, async () => {
 const s = await setup(false, failAt);
 try {
  await expect(s.start()).rejects.toThrow();
  expect(s.events).not.toContain("POST");
  expect(s.events).toEqual(failAt === "home" ? ["home"] : ["home", "GET", "attempts"]);
  if (failAt === "attempts") {
   const target = join(s.root, readdirSync(s.root)[0]);
   expect(existsSync(target)).toBe(true);
   await expect(s.start()).rejects.toThrow("reserved");
   expect(s.events).toEqual(["home", "GET", "attempts", "home"]);
  } else {
   await expect(s.start()).rejects.toThrow();
   expect(s.events).toEqual(["home", "home"]);
  }
 } finally { s.clean(); }
});
