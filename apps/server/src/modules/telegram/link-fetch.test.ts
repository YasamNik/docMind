import http from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { MockAgent } from "undici";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchReadablePage, pinnedLookup, readCappedBody, type LinkFetchLookup } from "./link-fetch.js";

const ARTICLE_HTML = `<!doctype html><html><head><title>A Long Article About Kettles</title></head>
<body><article><h1>A Long Article About Kettles</h1>
<p>This article explains, at some length, why an electric kettle boils water faster than
a stovetop one, with enough sentences here that readability's heuristics treat this as
the main content of the page rather than a sliver of boilerplate.</p>
<p>A second paragraph keeps the text density high enough for the same reason, since a
single short paragraph is sometimes not enough for the algorithm to be confident.</p>
</article></body></html>`;

const PLAIN_PAGE_HTML = `<!doctype html><html><head><title>Statement</title></head>
<body><div>Account 12345</div><div>Balance 100.00</div></body></html>`;

function publicLookup(address = "93.184.216.34"): LinkFetchLookup {
  return (_hostname, _options, callback) => callback(null, [{ address, family: 4 }]);
}

let mockAgent: MockAgent;

beforeEach(() => {
  mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
});

afterEach(async () => {
  await mockAgent.close();
});

describe("fetchReadablePage", () => {
  it("returns the readable text and the title of an article", async () => {
    mockAgent
      .get("https://example.com")
      .intercept({ path: "/article", method: "GET" })
      .reply(200, ARTICLE_HTML, { headers: { "content-type": "text/html; charset=utf-8" } });

    const result = await fetchReadablePage({ url: "https://example.com/article", dispatcher: mockAgent, lookup: publicLookup() });

    expect(result.title).toBe("A Long Article About Kettles");
    expect(result.text).toContain("boils water faster");
    expect(result.finalUrl).toBe("https://example.com/article");
  });

  it("falls back to the page's own text when readability finds no article", async () => {
    mockAgent
      .get("https://example.com")
      .intercept({ path: "/statement", method: "GET" })
      .reply(200, PLAIN_PAGE_HTML, { headers: { "content-type": "text/html" } });

    const result = await fetchReadablePage({ url: "https://example.com/statement", dispatcher: mockAgent, lookup: publicLookup() });

    expect(result.text).toContain("Account 12345");
    expect(result.text).toContain("Balance 100.00");
  });

  it("refuses a host that resolves to a private address", async () => {
    const lookup: LinkFetchLookup = (_hostname, _options, callback) => callback(null, [{ address: "127.0.0.1", family: 4 }]);

    await expect(fetchReadablePage({ url: "https://localhost.attacker.test/", lookup, dispatcher: mockAgent })).rejects.toThrow(/refus/i);
  });

  it("refuses a private address before ever building a real dispatcher", async () => {
    const lookup: LinkFetchLookup = (_hostname, _options, callback) => callback(null, [{ address: "169.254.169.254", family: 4 }]);

    // No dispatcher supplied: this exercises the branch that would otherwise build a
    // real, pinned undici Agent. The address check must reject before that happens,
    // so this never attempts a real connection.
    await expect(fetchReadablePage({ url: "https://metadata.internal/", lookup })).rejects.toThrow(/refus/i);
  });

  it("gives up on a lookup that never calls back, instead of hanging forever", async () => {
    const lookup: LinkFetchLookup = () => {
      // A hostile or merely slow nameserver: the callback this is handed is simply
      // never invoked. resolveAddress must bound this itself rather than wait on it.
    };

    await expect(
      fetchReadablePage({ url: "https://stalls-forever.test/", lookup, dispatcher: mockAgent, timeoutMs: 50 }),
    ).rejects.toThrow(/refus/i);
  });

  it("calls the lookup exactly once for a plain fetch with no redirects", async () => {
    mockAgent
      .get("https://example.com")
      .intercept({ path: "/article", method: "GET" })
      .reply(200, ARTICLE_HTML, { headers: { "content-type": "text/html" } });
    const lookup = vi.fn(publicLookup());

    await fetchReadablePage({ url: "https://example.com/article", dispatcher: mockAgent, lookup });

    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it("re-checks every redirect hop, so a public page cannot bounce inward", async () => {
    mockAgent
      .get("https://example.com")
      .intercept({ path: "/bounce", method: "GET" })
      .reply(302, "", { headers: { location: "http://169.254.169.254/" } });

    await expect(fetchReadablePage({ url: "https://example.com/bounce", dispatcher: mockAgent, lookup: publicLookup() })).rejects.toThrow(
      /refus/i,
    );
  });

  it("gives up after three redirects", async () => {
    for (let hop = 0; hop < 3; hop++) {
      mockAgent
        .get(`https://hop${hop}.example`)
        .intercept({ path: "/", method: "GET" })
        .reply(302, "", { headers: { location: `https://hop${hop + 1}.example/` } });
    }
    mockAgent
      .get("https://hop3.example")
      .intercept({ path: "/", method: "GET" })
      .reply(302, "", { headers: { location: "https://hop4.example/" } });

    await expect(fetchReadablePage({ url: "https://hop0.example/", dispatcher: mockAgent, lookup: publicLookup() })).rejects.toThrow(
      /refus|redirect/i,
    );
  });

  it("refuses a response that is not html or plain text", async () => {
    mockAgent
      .get("https://example.com")
      .intercept({ path: "/photo", method: "GET" })
      .reply(200, Buffer.from([0x89, 0x50, 0x4e, 0x47]), { headers: { "content-type": "image/png" } });

    await expect(fetchReadablePage({ url: "https://example.com/photo", dispatcher: mockAgent, lookup: publicLookup() })).rejects.toThrow(
      /refus/i,
    );
  });

  it("refuses a response past the size cap", async () => {
    const oversized = "a".repeat(11 * 1024 * 1024);
    mockAgent
      .get("https://example.com")
      .intercept({ path: "/huge", method: "GET" })
      .reply(200, oversized, { headers: { "content-type": "text/plain" } });

    await expect(fetchReadablePage({ url: "https://example.com/huge", dispatcher: mockAgent, lookup: publicLookup() })).rejects.toThrow(
      /refus/i,
    );
  });

  it("reads a text/plain response as-is", async () => {
    mockAgent
      .get("https://example.com")
      .intercept({ path: "/note", method: "GET" })
      .reply(200, "just some plain text", { headers: { "content-type": "text/plain" } });

    const result = await fetchReadablePage({ url: "https://example.com/note", dispatcher: mockAgent, lookup: publicLookup() });

    expect(result.text).toBe("just some plain text");
  });
});

describe("readCappedBody", () => {
  it("stops reading once the cap is crossed, without draining the rest of the stream", async () => {
    let chunksProduced = 0;
    async function* infinite() {
      while (true) {
        chunksProduced += 1;
        yield Buffer.alloc(1024, "a");
      }
    }
    const stream = Readable.from(infinite());

    await expect(readCappedBody(stream, 4096)).rejects.toThrow(/refus/i);

    // The cap is 4096 bytes at 1024 bytes a chunk: five chunks are enough to cross
    // it. Whatever the exact count, it must stay small, proving the generator was
    // never asked to produce the huge number of chunks an unbounded read would pull.
    expect(chunksProduced).toBeLessThan(20);
  });

  it("returns the full buffer when the stream stays under the cap", async () => {
    const stream = Readable.from([Buffer.from("hello "), Buffer.from("world")]);

    const result = await readCappedBody(stream, 4096);

    expect(result.toString("utf-8")).toBe("hello world");
  });
});

describe("pinnedLookup", () => {
  it("always answers with the address it was built from, no matter what hostname is asked at connect time", () => {
    const lookup = pinnedLookup({ address: "93.184.216.34", family: 4 });

    lookup("this-is-not-the-hostname-that-was-checked", {}, (err, address, family) => {
      expect(err).toBeNull();
      expect(address).toBe("93.184.216.34");
      expect(family).toBe(4);
    });
  });

  it("answers the 'all' shape with a single validated address", () => {
    const lookup = pinnedLookup({ address: "93.184.216.34", family: 4 });

    lookup("anything", { all: true }, (err, addresses) => {
      expect(err).toBeNull();
      expect(addresses).toEqual([{ address: "93.184.216.34", family: 4 }]);
    });
  });
});

// fetchReadablePage builds and later closes a real, pinned undici Agent whenever no
// dispatcher is injected, and every other test in this file injects a MockAgent, so
// that branch runs nowhere else. It cannot be driven end to end without a stand-in for
// isPublicAddress: the real guard refuses loopback before any dispatcher gets built,
// and loopback is what a local test server binds to. isPublicAddress has its own test
// suite (link-fetch.models.test.ts); stubbing it here only stands in for "some public
// address", it does not weaken what that suite already covers.
//
// A local server, started and torn down inside the test, is not a network call. It
// serves a body bigger than a stream's usual internal buffer and never delayed, so an
// unread body genuinely backpressures the socket instead of finishing on its own: this
// is what a dispatcher closed before its body was read used to stall on, all the way to
// fetchReadablePage's own twenty second deadline, confirmed against the pre-fix code
// with a five second race in place of that deadline.
describe("fetchReadablePage with no dispatcher injected", () => {
  const bodyBytes = 5 * 1024 * 1024;

  it("closes the real dispatcher it builds only after reading a large body in full", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(Buffer.alloc(bodyBytes, "a"));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const { port } = server.address() as AddressInfo;

    vi.resetModules();
    vi.doMock("./link-fetch.models.js", async (importOriginal) => {
      const actual = await importOriginal<typeof import("./link-fetch.models.js")>();
      return { ...actual, isPublicAddress: () => true };
    });

    try {
      const { fetchReadablePage: fetchWithOwnDispatcher } = await import("./link-fetch.js");
      const startedAt = Date.now();

      const result = await fetchWithOwnDispatcher({
        url: `http://127.0.0.1:${port}/`,
        lookup: (_hostname, _options, callback) => callback(null, [{ address: "127.0.0.1", family: 4 }]),
      });

      expect(result.text).toHaveLength(bodyBytes);
      expect(Date.now() - startedAt).toBeLessThan(5000);
    } finally {
      vi.doUnmock("./link-fetch.models.js");
      vi.resetModules();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
