import { expect, test } from "bun:test";

import { extractContent } from "./extract.ts";

const filler = "The quick brown fox jumps over the lazy dog. ".repeat(12);

test("an article is reduced to its title and body as Markdown, without navigation, with links made absolute", () => {
  const html = `<html><head><title>My Post</title></head><body>
    <nav><a href="/home">Home</a> <a href="/about">About</a></nav>
    <article><h1>My Post</h1><p>${filler}</p><p>Read <a href="/more">more here</a>.</p><ul><li>one</li><li>two</li></ul></article>
    <footer>copyright notice</footer></body></html>`;
  const page = extractContent(html, "https://example.test/blog/post");
  expect(page.title).toBe("My Post");
  expect(page.text).toContain("The quick brown fox");
  expect(page.text).toContain("[more here](https://example.test/more)");
  expect(page.text).toMatch(/-\s+one/);
  expect(page.text).not.toContain("About");
  expect(page.needsRendering).toBe(false);
});

test("images contribute their alt text and scripts contribute nothing", () => {
  const html = `<html><head><title>T</title><script>var secret = 1;</script></head><body><article><p>${filler}</p><img src="/a.png" alt="a chart of sales"><script>track()</script></article></body></html>`;
  const page = extractContent(html, "https://example.test/");
  expect(page.text).toContain("a chart of sales");
  expect(page.text).not.toContain("secret");
  expect(page.text).not.toContain("track()");
});

test("a page that is not an article still yields its body text", () => {
  const html = `<html><head><title>Status</title></head><body><div><h2>All systems operational</h2><div>${filler}</div></div></body></html>`;
  const page = extractContent(html, "https://example.test/");
  expect(page.text).toContain("All systems operational");
  expect(page.needsRendering).toBe(false);
});

test("signs of a script-built shell are recognised", () => {
  const scripts = Array.from({ length: 4 }, (_, index) => `<script src="/bundle${index}.js"></script>`).join("");
  const padding = `<!-- ${"x".repeat(6000)} -->`;
  const emptyRoot = extractContent(`<html><head><title>App</title></head><body><div id="root"></div></body></html>`, "https://example.test/");
  const hint = extractContent(`<html><body><noscript>You need to enable JavaScript to run this app.</noscript></body></html>`, "https://example.test/");
  const heavy = extractContent(`<html><head><title>App</title>${scripts}</head><body><div class="x"></div>${padding}</body></html>`, "https://example.test/");
  expect(emptyRoot.needsRendering).toBe(true);
  expect(hint.needsRendering).toBe(true);
  expect(heavy.needsRendering).toBe(true);
});

test("a short plain page is not mistaken for a shell", () => {
  const page = extractContent("<html><head><title>Hi</title></head><body><p>Short and complete.</p></body></html>", "https://example.test/");
  expect(page.text).toBe("Short and complete.");
  expect(page.needsRendering).toBe(false);
});

const fixture = (name: string) => Bun.file(new URL(`./fixtures/${name}`, import.meta.url)).text();
const page = (head: string, body: string) => `<html><head><title>T</title>${head}</head><body>${body}</body></html>`;
const SCRIPT_SRC = '<script src="/static/app.js"></script>';
const inlineScript = (chars: number) => `<script>var data = [${"1,".repeat(chars / 2)}];</script>`;

test("a page whose content a script builds is flagged even when it is small and has few scripts (a real page from quotes.toscrape.com/js)", async () => {
  const result = extractContent(await fixture("js-rendered-quotes.html"), "https://quotes.toscrape.com/js/");
  // What a model would otherwise be handed: two links and nothing else.
  expect(result.text.length).toBeLessThan(200);
  expect(result.needsRendering).toBe(true);
});

test("almost no text with an external script, or little text with a large inline script, is flagged", () => {
  expect(extractContent(page(SCRIPT_SRC, "<div id='content'></div>"), "https://example.test/").needsRendering).toBe(true);
  expect(extractContent(page(inlineScript(1200), "<div id='content'></div>"), "https://example.test/").needsRendering).toBe(true);
});

test("plain short pages are not flagged: no script, or only a small inline one", () => {
  expect(extractContent(page("", "<p>Short and complete.</p>"), "https://example.test/").needsRendering).toBe(false);
  expect(extractContent(page(inlineScript(200), "<p>Short, with a tiny inline script.</p>"), "https://example.test/").needsRendering).toBe(false);
});

test("data blocks that are not code do not count as scripts", () => {
  const data =
    '<script type="application/ld+json">{"@context":"https://schema.org","@type":"Thing","name":"x"}</script><script type="application/json" src="/data.json"></script>';
  const bigData = `<script type="application/ld+json">${JSON.stringify({ items: "x".repeat(3000) })}</script>`;
  expect(extractContent(page(data + bigData, "<p>Short page with structured data only.</p>"), "https://example.test/").needsRendering).toBe(false);
});

test("a page with real text is never flagged, whatever scripts it carries", () => {
  const body = `<article><p>${filler}</p><p>${filler}</p></article>`;
  expect(extractContent(page(SCRIPT_SRC + inlineScript(5000), body), "https://example.test/").needsRendering).toBe(false);
});

test("module scripts and scripts with an explicit javascript type count as code", () => {
  expect(extractContent(page('<script type="module" src="/main.js"></script>', "<div id='x'></div>"), "https://example.test/").needsRendering).toBe(true);
  expect(extractContent(page('<script type="text/javascript" src="/main.js"></script>', "<div id='x'></div>"), "https://example.test/").needsRendering).toBe(
    true,
  );
});

// Real markup of two pages seen while tuning the rule (2026-10-06), trimmed to what matters.
const EXAMPLE_COM =
  "<!doctype html><html lang=en><head><meta charset=utf-8><title>Example Domain</title></head><body><p>This domain is for use in documentation examples without needing permission. This is not a service; avoid relying on it for testing and monitoring purposes.</p><script src=/s.js></script></body></html>";
const VUE_TODOMVC =
  '<!DOCTYPE html><html lang="en"><head><title>TodoMVC: Vue</title><script type="module" crossorigin src="./assets/index-CO9Gq1IP.js"></script></head><body><section class="todoapp">\n</section><footer class="info"><p>Double-click to edit a todo</p><p>Created by the TodoMVC Team</p><p>Part of <a href="http://todomvc.com">TodoMVC</a></p></footer><script src="./base.js"></script></body></html>';

test("a readable short page with a classic beacon script is not flagged (example.com carries one)", () => {
  const result = extractContent(EXAMPLE_COM, "https://example.com/");
  expect(result.text).toContain("This domain is for use in documentation examples");
  expect(result.needsRendering).toBe(false);
});

test("an app frame with only a bundler's module script and some static footer text is flagged (TodoMVC on Vue)", () => {
  const result = extractContent(VUE_TODOMVC, "https://todomvc.com/examples/vue/dist/");
  expect(result.text.length).toBeGreaterThan(60);
  expect(result.text.length).toBeLessThan(200);
  expect(result.needsRendering).toBe(true);
});

test("a classic external script is a signal only when the page has almost no text", () => {
  expect(extractContent(page(SCRIPT_SRC, "<p>Not found.</p>"), "https://example.test/").needsRendering).toBe(true);
  expect(
    extractContent(page(SCRIPT_SRC, "<p>Sorry, we could not find the page you asked for. Try the home page or search.</p>"), "https://example.test/")
      .needsRendering,
  ).toBe(false);
});
