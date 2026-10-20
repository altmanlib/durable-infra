import { afterAll, beforeAll, expect, test } from "bun:test";
import { FetchError } from "./fetcher.ts";
import { BROWSER_HEADERS, HttpFetcher, type HttpFetcherOptions } from "./http-fetcher.ts";

const filler = "A paragraph of ordinary article text that goes on for a while. ".repeat(10);
const article = (title: string, extra = "") =>
  `<html><head><title>${title}</title></head><body><article><h1>${title}</h1><p>${filler}</p>${extra}</article></body></html>`;

const seen: { path: string; headers: Record<string, string>; at: number }[] = [];
let inFlight = 0;
let maxInFlight = 0;

let server: ReturnType<typeof Bun.serve>;
let base: string;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    idleTimeout: 30,
    async fetch(request) {
      const url = new URL(request.url);
      seen.push({ path: url.pathname, headers: Object.fromEntries(request.headers), at: Date.now() });
      const html = { "content-type": "text/html; charset=utf-8" };
      switch (url.pathname) {
        case "/article":
          return new Response(article("Hello World", '<p>See <a href="/other">other</a>.</p>'), { headers: html });
        case "/redirect":
          return new Response(null, { status: 302, headers: { location: "/article" } });
        case "/loop":
          return new Response(null, { status: 302, headers: { location: "/loop" } });
        case "/to-file":
          return new Response(null, { status: 302, headers: { location: "file:///etc/passwd" } });
        case "/slow":
          await new Promise((resolve) => setTimeout(resolve, 2000));
          return new Response("late", { headers: html });
        case "/busy": {
          inFlight++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise((resolve) => setTimeout(resolve, 80));
          inFlight--;
          return new Response(article("Busy"), { headers: html });
        }
        case "/big-declared":
          return new Response("x".repeat(5000), { headers: { "content-type": "text/plain", "content-length": "5000" } });
        case "/big-streamed":
          return new Response(
            new ReadableStream({
              async start(controller) {
                for (let index = 0; index < 20; index++) controller.enqueue(new TextEncoder().encode("y".repeat(500)));
                controller.close();
              },
            }),
            { headers: { "content-type": "text/plain" } },
          );
        case "/pdf":
          return new Response("%PDF-1.4", { headers: { "content-type": "application/pdf" } });
        case "/latin1":
          return new Response(
            new Uint8Array([
              ...new TextEncoder().encode("<html><head><title>Caf"),
              0xe9,
              ...new TextEncoder().encode(`</title></head><body><article><p>${filler}</p></article></body></html>`),
            ]),
            {
              headers: { "content-type": "text/html; charset=iso-8859-1" },
            },
          );
        case "/meta-charset":
          return new Response(
            new Uint8Array([
              ...new TextEncoder().encode('<html><head><meta charset="iso-8859-1"><title>Caf'),
              0xe9,
              ...new TextEncoder().encode(`</title></head><body><article><p>${filler}</p></article></body></html>`),
            ]),
            {
              headers: { "content-type": "text/html" },
            },
          );
        case "/forbidden":
          return new Response("no", { status: 403 });
        case "/limited":
          return new Response("slow down", { status: 429 });
        case "/challenge":
          return new Response("<html>Just a moment...</html>", { status: 503, headers: { "cf-mitigated": "challenge", ...html } });
        case "/missing":
          return new Response("gone", { status: 404 });
        case "/broken":
          return new Response("oops", { status: 500 });
        case "/plain":
          return new Response("  just some plain text\n", { headers: { "content-type": "text/plain; charset=utf-8" } });
        case "/spa":
          return new Response('<html><head><title>App</title></head><body><div id="root"></div></body></html>', { headers: html });
        case "/long":
          return new Response(article("Long", `<p>${"more words to read. ".repeat(200)}</p>`), { headers: html });
        case "/cookie-set":
          return new Response(null, { status: 302, headers: { location: "/cookie-check", "set-cookie": "session=abc123; Path=/; HttpOnly" } });
        case "/cookie-check":
          return new Response(
            `<html><head><title>cookie</title></head><body><article><p>${request.headers.get("cookie") ?? "no cookie"} ${filler}</p></article></body></html>`,
            { headers: html },
          );
        // A site that turns away clients which do not look like a browser.
        case "/ua-gate":
          return /Chrome\//.test(request.headers.get("user-agent") ?? "")
            ? new Response(article("Gated"), { headers: html })
            : new Response("no", { status: 403 });
        // A site that checks the connection against the claimed browser: a browser User-Agent is the thing it turns away.
        case "/fingerprint-gate":
          return /Chrome\//.test(request.headers.get("user-agent") ?? "")
            ? new Response("<html>Just a moment...</html>", { status: 403, headers: { "cf-mitigated": "challenge", ...html } })
            : new Response(article("Honest"), { headers: html });
        case "/always-turned-away":
          return new Response("<html>Just a moment...</html>", { status: 403, headers: { "cf-mitigated": "challenge", ...html } });
        // Turns away the plain request with a cookie; a retry that carried the cookie over is a different kind of failure.
        case "/cookie-gate":
          if (!/Chrome\//.test(request.headers.get("user-agent") ?? ""))
            return new Response("no", { status: 403, headers: { "set-cookie": "tainted=1; Path=/" } });
          return request.headers.get("cookie")?.includes("tainted")
            ? new Response("carried over", { status: 500 })
            : new Response(article("Clean"), { headers: html });
        case "/redirect-gate":
          return /Chrome\//.test(request.headers.get("user-agent") ?? "")
            ? new Response(null, { status: 302, headers: { location: "/article" } })
            : new Response("no", { status: 403 });
        default:
          return new Response("not here", { status: 404 });
      }
    },
  });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => server.stop(true));

// The test server is on 127.0.0.1, which the default address check refuses; its own tests are at the end.
const letThrough = async () => {};
const open = (options: HttpFetcherOptions = {}) => new HttpFetcher({ minHostIntervalMs: 0, checkAddress: letThrough, ...options });

async function failure(promise: Promise<unknown>): Promise<FetchError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof FetchError) return error;
    throw error;
  }
  throw new Error("expected a FetchError");
}

test("a page comes back with its title, Markdown text and final address", async () => {
  const page = await open().fetch(`${base}/article`);
  expect(page).toMatchObject({ status: 200, title: "Hello World", truncated: false, needsRendering: false });
  expect(page.text).toContain("A paragraph of ordinary article text");
  expect(page.text).toContain(`[other](${base}/other)`);
  expect(page.url).toBe(`${base}/article`);
});

test("redirects are followed, and the final address is reported", async () => {
  const page = await open().fetch(`${base}/redirect`);
  expect(page.url).toBe(`${base}/article`);
});

test("an endless redirect chain stops at the limit", async () => {
  const error = await failure(open({ maxRedirects: 3 }).fetch(`${base}/loop`));
  expect(error.kind).toBe("http");
  expect(seen.filter((entry) => entry.path === "/loop").length).toBe(4);
});

test("only http and https addresses are read, including after a redirect", async () => {
  expect((await failure(open().fetch("ftp://example.test/file"))).kind).toBe("invalid_url");
  expect((await failure(open().fetch("not a url"))).kind).toBe("invalid_url");
  expect((await failure(open().fetch(`${base}/to-file`))).kind).toBe("invalid_url");
});

const looksLikeBrowser = (headers: Record<string, string>) => /Chrome\//.test(headers["user-agent"] ?? "");

test("a request goes out with the runtime's own headers, and an ordinary page needs no other", async () => {
  seen.length = 0;
  await open().fetch(`${base}/article`);
  expect(seen.length).toBe(1);
  expect(looksLikeBrowser(seen[0]?.headers ?? {})).toBe(false);
  expect(seen[0]?.headers["sec-fetch-mode"]).toBeUndefined();
  expect(seen[0]?.headers["sec-ch-ua"]).toBeUndefined();
});

test("a site that turns the plain request away is asked again with a desktop browser's headers, and never as a bot", async () => {
  seen.length = 0;
  const page = await open().fetch(`${base}/ua-gate`);
  expect(page.title).toBe("Gated");
  expect(seen.length).toBe(2);
  expect(looksLikeBrowser(seen[0]?.headers ?? {})).toBe(false);
  const headers = seen[1]?.headers ?? {};
  expect(headers["user-agent"]).toMatch(/^Mozilla\/5\.0 .*Chrome\/\d+/);
  expect(headers["user-agent"]).not.toMatch(/bot|crawler|spider|fetch/i);
  expect(headers["sec-ch-ua"]).toContain("Chrome");
  expect(headers["sec-ch-ua-platform"]).toBe('"Windows"');
  expect(headers["sec-fetch-mode"]).toBe("navigate");
  expect(headers["sec-fetch-dest"]).toBe("document");
  expect(headers["accept-language"]).toBeTruthy();
  // The pieces must agree: the Chrome version in the client hints is the one in the User-Agent.
  const version = /Chrome\/(\d+)/.exec(BROWSER_HEADERS["user-agent"] ?? "")?.[1];
  expect(BROWSER_HEADERS["sec-ch-ua"]).toContain(`v="${version}"`);
});

test("the browser headers can be replaced as a whole", async () => {
  seen.length = 0;
  await open({ browserHeaders: { "user-agent": "Mozilla/5.0 Chrome/1 custom" } }).fetch(`${base}/ua-gate`);
  expect(seen[1]?.headers["user-agent"]).toBe("Mozilla/5.0 Chrome/1 custom");
  expect(seen[1]?.headers["sec-ch-ua"]).toBeUndefined();
});

test("a site that challenges browser headers is read with the plain request, in one go", async () => {
  seen.length = 0;
  const page = await open().fetch(`${base}/fingerprint-gate`);
  expect(page.title).toBe("Honest");
  expect(seen.length).toBe(1);
});

test("a site that turns away both kinds of request is a refusal after exactly two requests", async () => {
  seen.length = 0;
  const error = await failure(open().fetch(`${base}/always-turned-away`));
  expect(error.kind).toBe("refused");
  expect(seen.length).toBe(2);
  expect(looksLikeBrowser(seen[0]?.headers ?? {})).toBe(false);
  expect(looksLikeBrowser(seen[1]?.headers ?? {})).toBe(true);
});

test("a rate limit is not retried with other headers", async () => {
  seen.length = 0;
  expect((await failure(open().fetch(`${base}/limited`))).kind).toBe("refused");
  expect(seen.length).toBe(1);
});

test("after the switch the rest of the redirect chain keeps the browser headers, and the retry costs no redirect", async () => {
  seen.length = 0;
  const page = await open({ maxRedirects: 1 }).fetch(`${base}/redirect-gate`);
  expect(page.url).toBe(`${base}/article`);
  expect(seen.map((entry) => [entry.path, looksLikeBrowser(entry.headers)])).toEqual([
    ["/redirect-gate", false],
    ["/redirect-gate", true],
    ["/article", true],
  ]);
});

test("cookies set by the turned-away answer are not sent with the retry", async () => {
  expect((await open().fetch(`${base}/cookie-gate`)).title).toBe("Clean");
});

test("a cookie set during a redirect chain is sent on the next hop, and not remembered by the next call", async () => {
  const first = await open().fetch(`${base}/cookie-set`);
  expect(first.text).toContain("session=abc123");
  const second = await open().fetch(`${base}/cookie-check`);
  expect(second.text).toContain("no cookie");
});

test("a server that does not answer in time is a timeout", async () => {
  const error = await failure(open({ timeoutMs: 150 }).fetch(`${base}/slow`));
  expect(error.kind).toBe("timeout");
});

test("a call can be cancelled from outside", async () => {
  const controller = new AbortController();
  const pending = failure(open().fetch(`${base}/slow`, controller.signal));
  setTimeout(() => controller.abort(), 50);
  expect((await pending).kind).toBe("network");
});

test("a page over the size limit is an error whether or not the size was announced", async () => {
  expect((await failure(open({ maxBytes: 1000 }).fetch(`${base}/big-declared`))).kind).toBe("too_large");
  expect((await failure(open({ maxBytes: 1000 }).fetch(`${base}/big-streamed`))).kind).toBe("too_large");
});

test("types that cannot be read as text are refused", async () => {
  expect((await failure(open().fetch(`${base}/pdf`))).kind).toBe("unsupported_type");
});

test("the charset comes from the header, or else from a meta tag", async () => {
  expect((await open().fetch(`${base}/latin1`)).title).toBe("Café");
  expect((await open().fetch(`${base}/meta-charset`)).title).toBe("Café");
});

test("403, 429 and a bot challenge are refusals; other errors are plain HTTP errors", async () => {
  for (const path of ["/forbidden", "/limited", "/challenge"]) {
    const error = await failure(open().fetch(`${base}${path}`));
    expect([path, error.kind]).toEqual([path, "refused"]);
  }
  const missing = await failure(open().fetch(`${base}/missing`));
  expect([missing.kind, missing.status]).toEqual(["http", 404]);
  expect((await failure(open().fetch(`${base}/broken`))).kind).toBe("http");
});

test("a connection that cannot be made is a network error", async () => {
  const error = await failure(open().fetch("http://127.0.0.1:1/"));
  expect(error.kind).toBe("network");
});

test("plain text is returned as it is", async () => {
  const page = await open().fetch(`${base}/plain`);
  expect(page).toMatchObject({ text: "just some plain text", title: undefined, needsRendering: false });
});

test("an empty script-built page is flagged as needing rendering", async () => {
  expect((await open().fetch(`${base}/spa`)).needsRendering).toBe(true);
});

test("long text is cut at the limit and flagged", async () => {
  const page = await open({ maxTextChars: 500 }).fetch(`${base}/long`);
  expect(page.truncated).toBe(true);
  expect(page.text.length).toBe(500);
});

test("no more than the allowed number of requests run at once", async () => {
  maxInFlight = 0;
  const fetcher = open({ maxConcurrent: 2 });
  await Promise.all(Array.from({ length: 6 }, () => fetcher.fetch(`${base}/busy`)));
  expect(maxInFlight).toBe(2);
});

test("by default at most four requests run at once", async () => {
  maxInFlight = 0;
  const fetcher = open();
  await Promise.all(Array.from({ length: 8 }, () => fetcher.fetch(`${base}/busy`)));
  expect(maxInFlight).toBe(4);
});

test("requests to one host start at least the configured interval apart", async () => {
  seen.length = 0;
  const fetcher = new HttpFetcher({ minHostIntervalMs: 150, checkAddress: letThrough });
  await Promise.all([fetcher.fetch(`${base}/article`), fetcher.fetch(`${base}/article`), fetcher.fetch(`${base}/article`)]);
  const starts = seen.filter((entry) => entry.path === "/article").map((entry) => entry.at);
  expect(starts).toHaveLength(3);
  expect((starts[1] ?? 0) - (starts[0] ?? 0)).toBeGreaterThanOrEqual(130);
  expect((starts[2] ?? 0) - (starts[1] ?? 0)).toBeGreaterThanOrEqual(130);
});

test("the time spent waiting for a slot counts against the timeout", async () => {
  const fetcher = open({ maxConcurrent: 1, timeoutMs: 120 });
  const running = fetcher.fetch(`${base}/slow`).catch(() => {});
  const error = await failure(fetcher.fetch(`${base}/article`));
  expect(error.kind).toBe("timeout");
  await running;
});

test("by default an address on this machine is refused without being requested", async () => {
  let requested = 0;
  const counting = async () => {
    requested++;
    return new Response("x");
  };
  const fetcher = new HttpFetcher({ minHostIntervalMs: 0, fetch: counting as unknown as typeof fetch });
  for (const url of [base, "http://localhost:29433/api/health", "http://[::1]/", "http://169.254.169.254/latest/meta-data/"]) {
    expect([url, (await failure(fetcher.fetch(url))).kind]).toEqual([url, "blocked_address"]);
  }
  expect(requested).toBe(0);
});

test("a redirect from a public address to a private one is refused before it is followed", async () => {
  const requested: string[] = [];
  const fake = (async (url: URL) => {
    requested.push(url.href);
    return new Response(null, { status: 302, headers: { location: "http://metadata.internal/computeMetadata/v1/" } });
  }) as unknown as typeof fetch;
  const resolveHost = async (host: string) => (host === "example.test" ? ["93.184.216.34"] : ["169.254.169.254"]);
  const error = await failure(new HttpFetcher({ minHostIntervalMs: 0, fetch: fake, resolveHost }).fetch("http://example.test/"));
  expect(error.kind).toBe("blocked_address");
  expect(requested).toEqual(["http://example.test/"]);
});
