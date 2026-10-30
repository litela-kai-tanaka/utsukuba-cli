import * as cheerio from "cheerio";

export type ContentInspection = {
  url: string;
  text: string;
  links: { text: string; url: string }[];
  resources: { type: string; url: string }[];
  forms: { controls: { type: string; name?: string; label: string; options?: string[] }[] }[];
};

/** Inspection accepts only passive page/landing routes, never action parameters. */
export function inspectionUrl(target: string, baseUrl: string): string {
  const deny = () => new Error("Inspection requires an allowed read-only Manaba /ct page URL or ID (no query parameters).");
  try {
    const base = new URL(baseUrl);
    const url = new URL(target, `${baseUrl.replace(/\/$/, "")}/`);
    if (!/^https?:$/.test(base.protocol) || base.pathname.replace(/\/$/, "") !== "/ct"
      || base.username || base.password || base.search || base.hash
      || !target || /[\\\s%]/.test(target)
      || url.origin !== base.origin || url.username || url.password || url.search || url.hash
      || !/^\/ct\/(?:page_\d+(?:c\d+)?|course_\d+_drill_\d+(?:_submitlog_\d+)?)$/.test(url.pathname)) throw deny();
    return url.toString();
  } catch {
    throw deny();
  }
}

/** Static HTML only: no scripts, resource fetches, form actions or control values. */
export function parseContentInspection(html: string, url: string): ContentInspection {
  const $ = cheerio.load(html);
  const secrets: string[] = [];
  $("input,textarea,select").each((_, el) => {
    const node = $(el);
    if (/^(hidden|password)$/i.test(node.attr("type") ?? "") || /token|csrf|session|password|secret/i.test(node.attr("name") ?? "")) {
      const value = node.attr("value") ?? node.text();
      // Omit every hidden value, but do not globally replace benign flags such as 1.
      if (value && (value.length >= 8 || /^password$/i.test(node.attr("type") ?? "") || /token|csrf|session|password|secret/i.test(node.attr("name") ?? ""))) secrets.push(value);
      node.remove();
    }
  });
  const variants = [...new Set(secrets.flatMap((secret) => [secret, secret.replace(/\s+/g, " ").trim(), encodeURI(secret), encodeURIComponent(secret)]))]
    .filter(Boolean).sort((a, b) => b.length - a.length);
  const scrub = (value: string) => variants.reduce((text, secret) => text.split(secret).join("[redacted]"), value);
  const clean = (value: string) => scrub(scrub(value).replace(/\s+/g, " ").trim());
  $("script,style,noscript,template,nav,header,footer,[hidden],[aria-hidden='true'],input[type='hidden' i]").remove();
  $("[style]").each((_, el) => {
    if (/display\s*:\s*none|visibility\s*:\s*hidden/i.test($(el).attr("style") ?? "")) $(el).remove();
  });
  // Prefer the main region; keep a sanitized body fallback for older Manaba layouts.
  const root = [".articlebody", ".articletext", "main", "[role='main']", "#main", "#maincontent", ".mainbody"]
    .map((selector) => $(selector).first()).find((node) => node.length > 0);
  const content = root ?? $("body");
  const observedUrl = (value: string | undefined): string | undefined => {
    if (!value?.trim()) return undefined;
    try {
      const parsed = new URL(value, url);
      if (!/^https?:$/.test(parsed.protocol)) return undefined;
      parsed.username = "";
      parsed.password = "";
      // All query/fragment values are untrusted: tokens need not have recognizable names.
      parsed.search = "";
      parsed.hash = "";
      return scrub(parsed.toString());
    } catch { return undefined; }
  };
  const links: ContentInspection["links"] = [];
  content.find("a[href]").each((_, el) => {
    const href = observedUrl($(el).attr("href"));
    if (href) links.push({ text: clean($(el).text()), url: href });
  });
  const resources: ContentInspection["resources"] = [];
  content.find("iframe,embed,object").each((_, el) => {
    const href = observedUrl($(el).attr(el.tagName === "object" ? "data" : "src"));
    if (href) resources.push({ type: el.tagName, url: href });
  });
  const forms: ContentInspection["forms"] = [];
  content.find("form").each((_, form) => {
    const controls: ContentInspection["forms"][number]["controls"] = [];
    $(form).find("input,select,textarea,button").each((_, el) => {
      const node = $(el);
      const id = node.attr("id");
      const associated = id ? content.find("label").filter((_, label) => $(label).attr("for") === id).first().clone() : $([]);
      const labelNode = associated.length ? associated : node.closest("label").clone();
      labelNode.find("input,select,textarea,button").remove();
      const label = clean(labelNode.text() || node.attr("aria-label") || (el.tagName === "button" ? node.text() : node.is("input[type=submit],input[type=button]") ? node.attr("value") ?? "" : ""));
      controls.push({
        type: clean(node.attr("type") ?? (el.tagName === "input" ? "text" : el.tagName === "button" ? "submit" : el.tagName)),
        ...(node.attr("name") ? { name: clean(node.attr("name")!) } : {}),
        label,
        ...(el.tagName === "select" ? { options: node.find("option").toArray().map((option) => clean($(option).text())) } : {}),
      });
    });
    forms.push({ controls });
  });
  const textRoot = content.clone();
  textRoot.find("input,textarea,select,button,iframe,embed,object").remove();
  textRoot.find("br").replaceWith("\n");
  textRoot.find("p,div,section,article,h1,h2,h3,h4,h5,h6,li,tr,blockquote,pre").each((_, el) => {
    $(el).prepend("\n").append("\n");
  });
  const text = scrub(textRoot.text()).split(/\n/).map(clean).filter(Boolean).join("\n");
  return { url, text, links, resources, forms };
}
