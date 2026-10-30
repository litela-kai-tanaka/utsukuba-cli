import * as cheerio from "cheerio";
import { createHash, randomUUID } from "node:crypto";
import { constants, existsSync, lstatSync, mkdirSync, openSync, closeSync, writeFileSync, fsyncSync, renameSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import type { AppConfig } from "../domain/types";
import type { AuthUseCases } from "./manaba-client";
import { ManabaHttpClient } from "../infrastructure/http-client";
import { parseContentInspection } from "../infrastructure/content-inspection";
import { parseContentQuestions, type ContentQuestions } from "../infrastructure/content-questions";

import { parseAnswerDraft, validateAnswerPlan } from "./answer-plan";

const START = "action_DrillStudent_querystart";
type Binding = { profile: string; baseUrl: string; courseId: string; drillId: string; url: string };
type Journal = Binding & { stage: "post-pending" | "response-saved" | "unknown"; httpStatus?: number; rawBody?: string; privateRedactions?: string[]; location?: string | null;
 currentUrl?: string; revision?: string; opened?: boolean; operation?: string; questionDigest?: string; questions?: ContentQuestions;
 answerPlan?: ReturnType<typeof validateAnswerPlan>; answerDraft?: ReturnType<typeof parseAnswerDraft>; baselineLogIds?: string[]; answerResponseDigest?: string; finalReserved?: boolean;
};
export type DrillStepOptions = { operation: string; control: string; confirmTarget?: string; answers?: unknown };

/** One foreground start only. A reserved target is never automatically released, even after failure. */
export class DrillUseCases {
 constructor(private readonly config: AppConfig, private readonly http: ManabaHttpClient, private readonly auth: AuthUseCases, private readonly syncReservation: typeof fsyncSync = fsyncSync) {}
 async start(courseId: string, drillId: string, confirmation?: string) {
  const binding = this.binding(courseId, drillId);
  if (confirmation !== binding.url) throw new Error("Exact --confirm-start confirmation is required; no attempt was started.");
  const directory = this.directory(binding);
  if (existsSync(directory)) throw new Error("Attempt target already reserved; inspect-attempt instead. No repeat POST is allowed.");
  let cookies;
  let html: string;
  try {
   const profile = await this.auth.requireProfile();
   if (new URL(profile.baseUrl).toString().replace(/\/$/, "") !== binding.baseUrl || profile.profile !== binding.profile) throw new Error();
   cookies = profile.cookies;
   html = await this.http.getHtml(binding.url, cookies);
  } catch { throw new Error("Attempt preflight session/GET failed; no automatic login or redirect was attempted."); }
  const fields = startFields(html, binding.url);
  // mkdir is the exclusive reservation; a crash even before the journal write blocks another start.
  try {
   mkdirSync(directory, { mode: 0o700 });
   syncDirectory(dirname(directory), this.syncReservation);
  }
  catch { throw new Error("Attempt target already reserved or private store unavailable; no POST attempted."); }
  const stateFile = join(directory, "state.json");
  const journal: Journal = { ...binding, stage: "post-pending", privateRedactions: [fields.get("manaba-form")!, fields.get("SessionValue1")!, fields.get("SessionValue")!] };
  try { saveJournal(stateFile, journal); }
  catch { throw new Error("Private journal unavailable; target remains reserved. No POST attempted."); }
  try {
   const response = await this.http.postForm(binding.url, fields, cookies);
   journal.httpStatus = response.status;
   journal.location = response.headers.get("location");
   journal.rawBody = await response.text();
   journal.stage = "response-saved";
   saveJournal(stateFile, journal);
  } catch {
   journal.stage = "unknown";
   // Preserve any received status/location privately, never the transport error.
   try { saveJournal(stateFile, journal); } catch { /* Existing post-pending journal still prevents duplicate effects. */ }
  }
  return { stateFile, url: binding.url, stage: journal.stage, httpStatus: journal.httpStatus ?? null, actionNames: [START] };
 }
 async inspectAttempt(courseId: string, drillId: string) {
  const binding = this.binding(courseId, drillId);
  const stateFile = join(this.directory(binding), "state.json");
  let journal: Journal;
  try {
   safeAncestors(dirname(stateFile));
   const stat = lstatSync(stateFile);
   if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600 || stat.nlink !== 1) throw new Error();
   const fd = openSync(stateFile, constants.O_RDONLY | constants.O_NOFOLLOW);
   try { journal = JSON.parse(readFileSync(fd, "utf8")); } finally { closeSync(fd); }
   if (Object.entries(binding).some(([key, value]) => journal[key as keyof Binding] !== value)) throw new Error();
   if (journal.stage !== "response-saved" || typeof journal.rawBody !== "string") throw new Error();
  } catch { throw new Error("No safely bound saved response available; target may be reserved or unknown. Do not repeat start."); }
  const $ = cheerio.load(journal.rawBody);
  // Phase-one journals stored the benign manaba-form flag first; do not exempt any session/password entry.
  const secrets = [...(journal.privateRedactions ?? [])].filter((value,index)=>!(index === 0 && /^[0-9]$/.test(value)));
  $("input[type=hidden],input[type=password],input[name]").each((_, el) => { const node=$(el); const value=node.attr("value"); if (value && (node.is("input[type=hidden],input[type=password]") || /token|csrf|session|password|secret/i.test(node.attr("name") ?? "")) && !(node.is("input[type=hidden]") && isBenignFlag(node.attr("name"),value))) secrets.push(value); });
  const variants = [...new Set(secrets.flatMap(value => [value, value.replace(/\s+/g, " ").trim(), encodeURI(value), encodeURIComponent(value)]))].filter(Boolean).sort((a,b) => b.length-a.length);
  const redact = <T>(value: T): T => JSON.parse(JSON.stringify(value, (_, v) => typeof v === "string" ? variants.reduce((s, secret) => s.split(secret).join("[redacted]"), v) : v));
  const inspection = redact(parseContentInspection(journal.rawBody, binding.url));
  inspection.url = binding.url;
  let questions: ContentQuestions | null = null;
  try { questions = redact(parseContentQuestions(journal.rawBody, binding.url)); questions.url = binding.url; } catch { /* Unsupported layouts remain inspectable as safe metadata. */ }
  const observedControls: {name:string;label:string;operation:string;actionPath:string}[] = [];
  if (journal.currentUrl) $("input[type=submit],button[type=submit],button:not([type])").each((_,el)=>{
   const name=$(el).attr("name") ?? "";
   const label=($(el).is("input")?$(el).attr("value") ?? "":$(el).text()).replace(/\s+/g,"").trim();
   const operation=label === "次へ"?"next":"submit";
   try {
    const selected=stepFields(journal.rawBody!,journal.currentUrl!,binding,{operation,control:name});
    observedControls.push(redact({name,label,operation,actionPath:new URL(selected.url).pathname}));
   } catch { /* Unsupported controls are never offered as actionable metadata. */ }
  });
  return { stateFile, url: binding.url, stage: journal.stage, httpStatus: journal.httpStatus ?? null, inspection, questions, observedControls };
 }
 private load(binding: Binding): { stateFile: string; journal: Journal } {
  const stateFile = join(this.directory(binding), "state.json");
  try {
   safeAncestors(dirname(stateFile));
   const stat = lstatSync(stateFile);
   if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600 || stat.nlink !== 1) throw new Error();
   const fd = openSync(stateFile, constants.O_RDONLY | constants.O_NOFOLLOW);
   let journal: Journal;
   try { journal = JSON.parse(readFileSync(fd, "utf8")); } finally { closeSync(fd); }
   if (Object.entries(binding).some(([key, value]) => journal[key as keyof Binding] !== value)) throw new Error();
   return { stateFile, journal };
  } catch { throw new Error("No safely bound saved attempt state available."); }
 }
 private async profile(binding: Binding) {
  try {
   const profile = await this.auth.requireProfile();
   if (profile.profile !== binding.profile || new URL(profile.baseUrl).toString().replace(/\/$/, "") !== binding.baseUrl) throw new Error();
   return profile;
  } catch { throw new Error("Attempt session binding check failed; no automatic login attempted."); }
 }
 private reserve(stateFile: string, journal: Journal, kind: string) {
  const latest = this.load(this.binding(journal.courseId,journal.drillId)).journal;
  if (digest(latest) !== digest(journal) || journal.stage !== "response-saved") throw new Error("Attempt state changed or unknown; no replay allowed.");
  const lock = join(dirname(stateFile), `${kind}-${digest(journal)}.lock`);
  try {
   const fd = openSync(lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
   try { writeFileSync(fd, "reserved"); this.syncReservation(fd); } finally { closeSync(fd); }
   syncDirectory(dirname(stateFile), this.syncReservation);
  } catch { throw new Error("Attempt stage reserved or unavailable; no replay allowed."); }
 }
 private async readPage(binding: Binding, stateFile: string, url: string) {
  try {
   const profile = await this.profile(binding);
   const response = await this.http.getAttemptResponse(url, profile.cookies);
   const page = { url, httpStatus: response.status, location: response.headers.get("location"), rawBody: await response.text() };
   savePrivate(join(dirname(stateFile), `read-${randomUUID()}.json`), page);
   return page;
  } catch { throw new Error("Attempt GET failed; no redirects or retries attempted."); }
 }
 async openAttempt(courseId: string, drillId: string) {
  const binding = this.binding(courseId, drillId);
  const {stateFile, journal} = this.load(binding);
  if (journal.stage !== "response-saved" || !journal.location || !(journal.httpStatus && [302,303].includes(journal.httpStatus))) throw new Error("No saved pending Location to open.");
  const url = attemptRoute(journal.location, journal.currentUrl ?? binding.url, binding, true);
  // Only one manual GET per saved response, including uncertain transport outcomes.
  await this.profile(binding);
  this.reserve(stateFile, journal, "open");
  journal.stage = "post-pending";
  saveJournal(stateFile, journal);
  try {
   const page = await this.readPage(binding, stateFile, url);
   journal.rawBody = page.rawBody; journal.httpStatus = page.httpStatus; journal.location = page.location;
   journal.currentUrl = url; journal.revision = randomUUID(); journal.opened = true;
   journal.stage = "response-saved";
   if (journal.operation === "next") journal.answerResponseDigest = responseDigest(journal);
   saveJournal(stateFile, journal);
  } catch { journal.stage = "unknown"; try { saveJournal(stateFile,journal); } catch {} }
  return this.inspectAttempt(courseId,drillId);
 }
 async step(courseId: string, drillId: string, options: DrillStepOptions) {
  const binding = this.binding(courseId, drillId);
  if (options.confirmTarget !== binding.url) throw new Error("Exact --confirm-target confirmation required.");
  if (!["next","submit"].includes(options.operation)) throw new Error("Unsupported attempt operation.");
  const {stateFile, journal} = this.load(binding);
  if (journal.stage !== "response-saved" || !journal.opened || journal.finalReserved || journal.httpStatus !== 200 || journal.location || !journal.rawBody) throw new Error("Attempt state unavailable, reserved or unknown; no POST attempted.");
  const source = structuredClone(journal);
  const selected = stepFields(journal.rawBody, journal.currentUrl!, binding, options);
  if (options.operation === "next") {
   if (journal.answerPlan) throw new Error("Validated answer step already reserved; no replay allowed.");
   const questions = parseContentQuestions(journal.rawBody, journal.currentUrl!);
   const draft = parseAnswerDraft(options.answers);
   const plan = validateAnswerPlan(questions, draft);
   for (const answer of draft.answers) for (const id of answer.optionIds) {
    const inputs = selected.form.find("input").filter((_, el) => selected.$(el).attr("name") === answer.questionId && selected.$(el).attr("value") === id);
    if (inputs.length !== 1 || !inputs.is("input[type=radio],input[type=checkbox]") || inputs.is(":disabled") || inputs.attr("form")) throw new Error("Answer plan does not match current enabled question controls.");
    selected.fields.append(answer.questionId,id);
   }
   // Freeze history BEFORE the first answer POST, never infer submission from an old score.
   const baseline = await this.readPage(binding, stateFile, binding.url);
   if (baseline.httpStatus !== 200 || baseline.location) throw new Error("Baseline landing unavailable; no POST attempted.");
   assertEligibility(baseline.rawBody);
   journal.baselineLogIds = historyIds(baseline.rawBody,binding);
   // Reservation compares against original state, before attaching the private plan.
   await this.profile(binding);
   this.reserve(stateFile,source,"write");
   const latest = this.load(binding).journal;
   if (responseDigest(latest) !== responseDigest(journal) || latest.answerPlan || latest.stage !== "response-saved") throw new Error("Attempt state changed; no POST attempted.");
   journal.questions = questions; journal.questionDigest = digest(questions); journal.answerDraft = draft; journal.answerPlan = plan;
  } else {
   if (options.answers !== undefined || !journal.answerPlan?.valid || !journal.questions || !journal.questionDigest || digest(journal.questions) !== journal.questionDigest || !journal.answerDraft || digest(validateAnswerPlan(journal.questions,journal.answerDraft)) !== digest(journal.answerPlan) || !journal.baselineLogIds || journal.operation !== "next" || journal.answerResponseDigest !== responseDigest(journal)) throw new Error("Final submission requires this attempt's validated answer response.");
   // Fresh landing status guards deadlines and limits again before the final effect.
   const landing = await this.readPage(binding,stateFile,binding.url);
   if (landing.httpStatus !== 200 || landing.location) throw new Error("Landing unavailable; no POST attempted.");
   assertEligibility(landing.rawBody);
   await this.profile(binding);
   this.reserve(stateFile,journal,"write");
   journal.finalReserved = true;
  }
  journal.privateRedactions = [...new Set([...(journal.privateRedactions ?? []), ...selected.secrets])];
  journal.stage = "post-pending"; journal.operation = options.operation;
  // Full questions, answers, digest and baseline persist durably before POST.
  saveJournal(stateFile,journal);
  try {
   const profile = await this.profile(binding);
   const response = await this.http.postForm(selected.url,selected.fields,profile.cookies);
   journal.rawBody = await response.text(); journal.httpStatus = response.status; journal.location = response.headers.get("location");
   journal.currentUrl = selected.url; journal.revision = randomUUID(); journal.stage = "response-saved";
   if (options.operation === "next") journal.answerResponseDigest = responseDigest(journal);
   saveJournal(stateFile,journal);
  } catch { journal.stage = "unknown"; try { saveJournal(stateFile,journal); } catch {} }
  return {stateFile,url:binding.url,stage:journal.stage,httpStatus:journal.httpStatus ?? null,operation:options.operation,submitted:false as const};
 }
 async verify(courseId: string, drillId: string) {
  const binding = this.binding(courseId,drillId);
  const {stateFile,journal} = this.load(binding);
  if (!journal.finalReserved || !journal.baselineLogIds || !journal.answerPlan?.valid) return {url:binding.url,submitted:false,newLogIds:[] as string[]};
  const landing = await this.readPage(binding,stateFile,binding.url);
  if (landing.httpStatus !== 200 || landing.location) throw new Error("Verification landing unavailable.");
  const candidates = historyIds(landing.rawBody,binding).filter(id=>!journal.baselineLogIds!.includes(id));
  const verified: string[] = [];
  for (const id of candidates) {
   const page = await this.readPage(binding,stateFile,`${binding.url}_submitlog_${id}`);
   if (page.httpStatus !== 200 || page.location) continue;
   if (hasGradedEvidence(page.rawBody)) verified.push(id);
  }
  savePrivate(join(dirname(stateFile),`verification-${randomUUID()}.json`),{baseline:journal.baselineLogIds,candidates,verified});
  return {url:binding.url,submitted:verified.length > 0,newLogIds:verified};
 }
 private binding(courseId: string, drillId: string): Binding {
  let base: URL;
  try { base = new URL(this.config.baseUrl); } catch { throw new Error("Unsupported drill target."); }
  if (courseId !== "351845" || drillId !== "4141433" ||
   (base.origin !== "https://manaba.tsukuba.ac.jp" && !(["127.0.0.1", "[::1]", "localhost"].includes(base.hostname) && /^https?:$/.test(base.protocol))) ||
   base.pathname.replace(/\/$/, "") !== "/ct" || base.username || base.password || base.search || base.hash ||
   !/^[A-Za-z0-9_-]{1,80}$/.test(this.config.profile)) throw new Error("Unsupported drill target.");
  const baseUrl = `${base.origin}/ct`;
  return { profile: this.config.profile, baseUrl, courseId, drillId, url: `${baseUrl}/course_${courseId}_drill_${drillId}` };
 }
 private directory(binding: Binding): string {
  try {
   if (!isAbsolute(this.config.homeDir) || resolve(this.config.homeDir) !== this.config.homeDir) throw new Error();
   safeAncestors(this.config.homeDir);
   const root = join(this.config.homeDir, "attempts");
   if (!existsSync(root)) mkdirSync(root, { mode: 0o700 });
   const stat = lstatSync(root);
   if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700) throw new Error();
   // Retry this sync even for an existing root: its creation may have failed to persist previously.
   syncDirectory(this.config.homeDir, this.syncReservation);
   const key = createHash("sha256").update(JSON.stringify(binding)).digest("hex");
   const directory = join(root, key);
   if (existsSync(directory)) {
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700) throw new Error();
   }
   return directory;
  } catch { throw new Error("Unsafe or unavailable private attempt store."); }
 }
}

function digest(value: unknown) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function responseDigest(journal: Journal) { return digest([journal.currentUrl,journal.rawBody,journal.httpStatus,journal.location,journal.revision]); }
function savePrivate(path: string, value: unknown) { saveJournal(path,value as Journal); }
function isBenignFlag(name: string | undefined, value: string) { return name === "manaba-form" && /^[0-9]$/.test(value); }
/** Only observed exact-target routes; query values can only be the saved refresh nonce. */
function attemptRoute(raw: string, current: string, binding: Binding, allowRefresh: boolean) {
 const fail = () => new Error("Unsafe or unsupported saved attempt route.");
 try {
  if (!raw || /[\\\s%]/.test(raw)) throw fail();
  const url = new URL(raw,current); const target = new URL(binding.url);
  if (url.origin !== target.origin || url.username || url.password || url.hash ||
   !new RegExp(`^${target.pathname}_(?:queryshow|queryconfirm|confirm|confirmation|result|queryresult)$`).test(url.pathname)) throw fail();
  const keys = [...url.searchParams.keys()];
  if (keys.length && (!allowRefresh || keys.length !== 1 || keys[0] !== "refresh" || !/^[A-Za-z0-9_.~-]{1,256}$/.test(url.searchParams.get("refresh") ?? ""))) throw fail();
  return url.toString();
 } catch { throw fail(); }
}
function hasGradedEvidence(html: string) {
 const $ = cheerio.load(html);
 if ($("base,input[type=password],form[action*='login'],form[action*='Login'],input[name='j_username']").length) return false;
 $("script,style,[hidden],[aria-hidden=true]").remove();
 const numeric = (text: string) => /^(?:100|[0-9]{1,2})(?:\.\d+)?(?:点)?$/.test(text.trim());
 // Grade header is outside the question body in the observed INFOSS layout.
 if ($("td.querystatus").toArray().some(el=> /採点結果/.test($(el).text()) && $(el).find("span").toArray().some(span=>numeric($(span).text())))) return true;
 return $("tr").toArray().some(el=>{
  const cells=$(el).children("th,td");
  return /^(?:得点|点数|score)$/i.test(cells.first().text().trim()) && numeric(cells.eq(1).text());
 });
}
function historyIds(html: string, binding: Binding) {
 const $ = cheerio.load(html); const ids = new Set<string>();
 if ($("base").length || $("input[type=password]").length) throw new Error("Unsupported landing evidence.");
 $("a[href]").each((_,el)=>{
  try {
   const raw = $(el).attr("href")!;
   if (/[\\\s%]/.test(raw)) return;
   const url = new URL(raw,binding.url);
   const match = new RegExp(`^${new URL(binding.url).pathname}_submitlog_([0-9]{1,20})$`).exec(url.pathname);
   if (match && url.origin === new URL(binding.url).origin && !url.search && !url.hash && !url.username && !url.password) ids.add(match[1]);
  } catch {}
 });
 return [...ids].sort();
}
function assertEligibility(html: string) {
 const $ = cheerio.load(html);
 const rows = (label: string) => $("tr").filter((_,el)=>$(el).children("th,td").first().text().replace(/\s+/g,"") === label);
 const status = rows("状態"); const cell = status.first().children("th,td").eq(1);
 const node = cell.contents().toArray().find(el=>$(el).text().trim());
 if (status.length !== 1 || !node || $(node).text().trim() !== "受付中" || rows("提出上限").length !== 1 || rows("提出上限").first().children("th,td").slice(1).text().replace(/\s+/g,"") !== "無制限" || rows("受付終了日時").length !== 1 || rows("受付終了日時").first().children("th,td").slice(1).text().replace(/\s+/g,"") !== "未設定") throw new Error("Attempt unavailable, limited or deadline-bound; no POST attempted.");
}
function stepFields(html: string, current: string, binding: Binding, options: DrillStepOptions) {
 const fail = () => new Error("Unsupported, unsafe or ambiguous observed attempt form/control; no POST attempted.");
 attemptRoute(current,binding.url,binding,true);
 const $ = cheerio.load(html);
 if ($("base,input[type=password]").length || !/^action_DrillStudent_[A-Za-z0-9_]{1,100}$/.test(options.control) || /pause|restart|logout|redirectstart|querystart/i.test(options.control)) throw fail();
 const controls = $("input,button").filter((_,el)=>$(el).attr("name") === options.control);
 if (controls.length !== 1) throw fail();
 const control = controls.first(); const form = control.closest("form");
 if (form.length !== 1 || form.attr("method")?.toLowerCase() !== "post" || !control.is("input[type=submit],button[type=submit],button:not([type])") || control.is(":disabled") || control.closest("[hidden],[aria-hidden=true]").length || control.attr("form") || control.attr("formmethod") && control.attr("formmethod")?.toLowerCase() !== "post") throw fail();
 const label = (control.is("input") ? control.attr("value") ?? "" : control.text()).replace(/\s+/g,"").trim();
 if (options.operation === "next" ? label !== "次へ" : !/^(?:提出|採点|完了)(?:する|して終了)?$/.test(label)) throw fail();
 const action = form.attr("action"); if (!action) throw fail();
 const url = attemptRoute(action,current,binding,false);
 if (control.attr("formaction") && attemptRoute(control.attr("formaction")!,current,binding,false) !== url) throw fail();
 const fields = new URLSearchParams(); const secrets: string[] = [];
 form.find("input,select,textarea,button").each((_,el)=>{
  const node=$(el); const name=node.attr("name");
  if (!name || node.is(":disabled") || node.is("input[type=submit],input[type=button],input[type=reset],button")) return;
  if (node.attr("form")) throw fail();
  if (node.is("input[type=hidden]")) {
   if (fields.has(name) || /^action_/i.test(name) || /^qid\d+$/i.test(name)) throw fail();
   fields.append(name,node.attr("value") ?? "");
   if (node.attr("value") && !isBenignFlag(name,node.attr("value")!)) secrets.push(node.attr("value")!);
  } else if (!node.is("input[type=radio],input[type=checkbox]") || !/^qid[0-9]{1,3}$/.test(name)) throw fail();
 });
 if (!fields.has("SessionValue") || !fields.has("SessionValue1") || !fields.has("manaba-form")) throw fail();
 fields.append(options.control,control.attr("value") ?? "");
 return {$,form,fields,secrets,url};
}

function syncDirectory(path: string, sync: typeof fsyncSync) {
 const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
 try { sync(fd); } finally { closeSync(fd); }
}

function safeAncestors(path: string) {
 const root = parse(path).root;
 let current = root;
 for (const part of path.slice(root.length).split("/").filter(Boolean)) {
  current = join(current, part);
  const stat = lstatSync(current);
  if (stat.isSymbolicLink() || !stat.isDirectory() || existsSync(join(current, ".git"))) throw new Error();
 }
}
function saveJournal(path: string, journal: Journal) {
 const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
 const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
 try { writeFileSync(fd, JSON.stringify(journal), "utf8"); fsyncSync(fd); } finally { closeSync(fd); }
 renameSync(temporary, path);
 const directoryFd = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
 try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
 // Retain the redirect and every private planned/pending/response state across transitions.
 if (path.endsWith("/state.json")) saveJournal(join(dirname(path),`state-${digest(journal)}.json`),journal);
}

function startFields(html: string, url: string): URLSearchParams {
 const fail = () => new Error("Unavailable, expired, unsupported or ambiguous drill start form; no POST attempted.");
 const $ = cheerio.load(html);
 // Require the observed live acceptance/limit/deadline rows, not mere prose or stale history.
 const row = (label: string) => $("tr").filter((_, el) => $(el).children("th,td").first().text().replace(/\s+/g, "").trim() === label)
  .toArray().map(el => $(el).children("th,td").slice(1).text().replace(/\s+/g, "").trim());
 const statusRows = $("tr").filter((_, el) => $(el).children("th,td").first().text().trim() === "状態");
 const statusCell = statusRows.first().children("th,td").eq(1);
 const firstStatusNode = statusCell.contents().toArray().find(node => $(node).text().trim());
 const status = firstStatusNode ? $(firstStatusNode).text().trim() : "";
 if (statusRows.length !== 1 || status !== "受付中" || row("提出上限").length !== 1 || row("提出上限")[0] !== "無制限" || row("受付終了日時").length !== 1 || row("受付終了日時")[0] !== "未設定") throw fail();
 const controls = $(`[name='${START}']`);
 if (controls.length !== 1 || $("base").length) throw fail();
 const control = controls.first();
 const form = control.closest("form");
 if (form.length !== 1 || form.attr("method")?.toLowerCase() !== "post" || control.is(":disabled") || control.closest("[hidden],[aria-hidden=true]").length || !control.is("input[type=submit],button[type=submit],button:not([type])")) throw fail();
 if (control.attr("form") || control.attr("formmethod") && control.attr("formmethod")?.toLowerCase() !== "post") throw fail();
 for (const action of [form.attr("action"), control.attr("formaction") ?? form.attr("action")]) {
  if (!action || /[\\\s%]/.test(action)) throw fail();
  try { if (new URL(action, url).toString() !== url) throw fail(); } catch { throw fail(); }
 }
 const fields = new URLSearchParams();
 for (const name of ["manaba-form", "SessionValue1", "SessionValue"]) {
  const input = form.find(`[name='${name}']`);
  if (input.length !== 1 || !input.is("input[type=hidden]") || input.is(":disabled") || input.attr("form") || !input.attr("value")) throw fail();
  fields.set(name, input.attr("value")!);
 }
 // Do not silently invent required fields or accept additional successful inputs.
 if (form.find("input,select,textarea,button").filter((_, el) => !["manaba-form", "SessionValue1", "SessionValue", START].includes($(el).attr("name") ?? "") && !!$(el).attr("name") && !$(el).is("input[type=submit],button,:disabled")).length) throw fail();
 fields.set(START, control.attr("value") ?? "");
 return fields;
}
