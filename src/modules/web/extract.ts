import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";

type Doc = ReturnType<typeof parseHTML>["document"];

export type Extracted = { title: string | undefined; text: string; needsRendering: boolean };

/** Below this many characters of text, a page with the signs of a script-built shell counts as not rendered. */
const MIN_TEXT_CHARS = 200;
/** Inline script code beyond this is more than a snippet: it is likely to carry the page's content or build it. */
const INLINE_CODE_CHARS = 1000;
/** `type` values of a script that runs; anything else (ld+json, importmap, templates) is data. */
const CODE_TYPES = new Set(["", "text/javascript", "application/javascript", "module"]);
/** A page this empty with any external script is a frame for it; with more text, a classic script is just a beacon or widget. */
const EMPTY_PAGE_CHARS = 60;
const NEEDS_SCRIPT_HINT = /(enable|requires?|turn on)\s+javascript|javascript\s+(is\s+)?(required|disabled|must be enabled)/i;
/** Mount points of single-page apps. */
const APP_ROOTS = ["#root", "#app", "#__next", "#__nuxt"];

function markdown(): TurndownService {
  const service = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-" });
  // Images carry no text a model can read; keep what the author wrote about them.
  service.addRule("image", {
    filter: "img",
    replacement: (_content, node) => (node as unknown as { getAttribute(name: string): string | null }).getAttribute("alt")?.trim() ?? "",
  });
  // Turndown's tag names are the HTML ones; svg is a tag it matches by name all the same.
  service.remove(["script", "style", "noscript", "iframe", "svg"] as unknown as Parameters<typeof service.remove>[0]);
  return service;
}

function squeeze(text: string): string {
  return text.replace(/\n{3,}/g, "\n\n").trim();
}

/** What the scripts of a page add up to: those loaded from elsewhere (bundler output is a module), and inline code. */
function scriptsOf(document: Doc): { externalModules: number; externalClassic: number; inlineChars: number } {
  let externalModules = 0;
  let externalClassic = 0;
  let inlineChars = 0;
  for (const script of document.querySelectorAll("script")) {
    const type = (script.getAttribute("type") ?? "").trim().toLowerCase();
    if (!CODE_TYPES.has(type)) continue;
    if (!script.getAttribute("src")) inlineChars += (script.textContent ?? "").length;
    else if (type === "module") externalModules++;
    else externalClassic++;
  }
  return { externalModules, externalClassic, inlineChars };
}

/**
 * Signs that the document is an empty frame for a script to fill, judged only when there is little text: an empty app
 * mount point, a hint that needs JavaScript, a large inline script, a module script (what bundlers emit), or any
 * external script on a page with almost no text. A classic external script next to a real sentence is left alone:
 * that is a beacon or a widget (example.com carries one). A false alarm costs one needless render of a short page,
 * which comes out the same, but until rendering exists it also tells the model a readable page is unreadable; a miss
 * hands the model an empty page without a word (a real one, quotes.toscrape.com/js: two links, its quotes built by an
 * inline script). Kept in one place so the rule is easy to tune.
 */
export function looksLikeShell(document: Doc, textLength: number): boolean {
  if (textLength >= MIN_TEXT_CHARS) return false;
  const emptyRoot = APP_ROOTS.some((selector) => {
    const root = document.querySelector(selector);
    return root !== null && (root.textContent ?? "").trim() === "";
  });
  if (emptyRoot) return true;
  const hint = [...document.querySelectorAll("noscript")].some((node) => NEEDS_SCRIPT_HINT.test(node.textContent ?? ""));
  if (hint) return true;
  const { externalModules, externalClassic, inlineChars } = scriptsOf(document);
  return inlineChars > INLINE_CODE_CHARS || externalModules > 0 || (externalClassic > 0 && textLength < EMPTY_PAGE_CHARS);
}

/** Main text of an HTML page as Markdown, with relative links resolved against `url`. */
export function extractContent(html: string, url: string): Extracted {
  const shown = parseHTML(html).document;
  const forReader = parseHTML(html).document;
  // Relative links in the extracted text should point somewhere a reader can follow.
  const base = forReader.createElement("base");
  base.setAttribute("href", url);
  forReader.head?.prepend(base);

  const converter = markdown();
  const article = new Readability(forReader as never).parse();
  let text = article?.content ? squeeze(converter.turndown(article.content)) : "";
  // Readability finds nothing on pages that are not articles; fall back to the whole body.
  if (text === "" && shown.body) text = squeeze(converter.turndown(shown.body.innerHTML));
  const title = (article?.title || shown.title || "").trim() || undefined;
  return { title, text, needsRendering: looksLikeShell(shown, text.length) };
}

/** Plain text and other non-HTML bodies are returned as they are. */
export function extractPlain(body: string): Extracted {
  return { title: undefined, text: body.trim(), needsRendering: false };
}
