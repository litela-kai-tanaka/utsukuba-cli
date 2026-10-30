import * as cheerio from "cheerio";

export type ContentQuestions = { url: string; questions: { questionId: string; type: "radio" | "checkbox"; required: boolean; prompt: string; options: { optionId: string; text: string }[] }[] };

/** Extract only prompts/options, never response state or submission feedback. */
export function parseContentQuestions(html: string, url: string): ContentQuestions {
  const $ = cheerio.load(html);
  const fail = () => new Error("Unsupported or ambiguous question layout; only bounded radio/checkbox groups are supported.");
  const secrets: string[] = [];
  $("input,textarea,select").each((_, el) => {
    const node = $(el);
    if (/^(hidden|password)$/i.test(node.attr("type") ?? "") || /token|csrf|session|password|secret/i.test(node.attr("name") ?? "")) {
      const value = node.attr("value") ?? node.text();
      if (value && !(node.attr("type")?.toLowerCase() === "hidden" && node.attr("name") === "manaba-form" && /^[0-9]$/.test(value))) secrets.push(value);
      node.find("option[value]").each((_,option)=>{const v=$(option).attr("value"); if(v) secrets.push(v);});
      node.remove();
    }
  });
  const variants = [...new Set(secrets.flatMap(s=>[s,s.replace(/\s+/g," ").trim(),encodeURI(s),encodeURIComponent(s)]))].filter(Boolean).sort((a,b)=>b.length-a.length);
  const scrub = (text: string) => variants.reduce((s,v)=>s.split(v).join("[redacted]"),text);
  const clean = (text: string) => scrub(scrub(text).replace(/\s+/g," ").trim());
  $("script,style,noscript,template,[hidden],[aria-hidden=true]").remove();
  $("[style]").each((_,el)=>{if(/display\s*:\s*none|visibility\s*:\s*hidden/i.test($(el).attr("style") ?? "")) $(el).remove();});
  $(".pointform input.point[type=text]:not([name])").remove();
  if ($("fieldset,.querypaper,.querybody,.queryselection").find("textarea,select,input:not([type=radio]):not([type=checkbox]):not([type=submit]):not([type=button]):not([type=reset])").length) throw fail();
  const safeId = (id: string) => /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(id) && !/^(?:__proto__|prototype|constructor)$/i.test(id) && !/token|csrf|session|password|secret/i.test(id) && scrub(id)===id;
  const groups = new Map<string, ReturnType<typeof $>[]>();
  $("input[type=radio],input[type=checkbox]").each((_,el) => {
    const node = $(el);
    const name = node.attr("name") ?? "";
    const group = groups.get(name) ?? [];
    group.push(node); groups.set(name, group);
  });
  if (!groups.size) throw fail();
  const questions: ContentQuestions["questions"] = [];
  for (const [questionId, nodes] of groups) {
    if (!safeId(questionId) || new Set(nodes.map(n=>n.attr("type"))).size !== 1 || nodes.some(n=>!safeId(n.attr("value") ?? "")) || new Set(nodes.map(n=>n.attr("value"))).size !== nodes.length) throw fail();
    const first = nodes[0];
    const container = first.closest(".queryselection,fieldset");
    let previous = container.prev();
    while (previous.is("br,.query_required_marker")) previous = previous.prev();
    const promptNode = container.is("fieldset") ? container.find("legend").first().clone() : previous.is("p") ? previous.clone() : $([]);
    promptNode.find(".query_required_marker,input,button,textarea,select").remove();
    if (!container.length || !clean(promptNode.text()) || nodes.some(n=>n.closest(".queryselection,fieldset")[0] !== container[0])) throw fail();
    questions.push({ questionId, type:first.attr("type") as "radio" | "checkbox", required:container.hasClass("required") || nodes.some(n=>n.is("[required]")), prompt:clean(promptNode.text()), options:nodes.map(node=>{
      const id = node.attr("id");
      const associated = id ? $("label").filter((_,el)=>$(el).attr("for")===id).first() : $([]);
      const label = (associated.length ? associated : node.closest("label").length ? node.closest("label") : node.closest("li")).clone();
      label.find("input").remove();
      return {optionId:node.attr("value") ?? "",text:clean(label.text())};
    }) });
  }
  return {url,questions};
}
