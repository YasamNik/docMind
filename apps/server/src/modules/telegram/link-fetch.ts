import net from "node:net";
import dns from "node:dns";
import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { Agent, fetch as undiciFetch, type Dispatcher, type Response as UndiciResponse } from "undici";
import { parseHTML } from "linkedom";
import { Readability } from "@mozilla/readability";
import { createError } from "../../shared/errors/errors.js";
import { assertFetchableUrl, isPublicAddress } from "./link-fetch.models.js";

// Turns a telegram link message into readable text. The one dangerous part of this
// module is reachable from outside DocMind entirely, so every network step is guarded:
// scheme, resolved address, every redirect hop, response size and response type.

const MAX_REDIRECTS = 3;
const MAX_BODY_BYTES = 10 * 1024 * 1024;
const TIMEOUT_MS = 20_000;
const ALLOWED_CONTENT_TYPES = new Set(["text/html", "text/plain"]);

function linkRefused(message: string) {
  return createError({ code: "telegram.link_refused", message: `Link refused: ${message}`, status: 400 });
}

type ResolvedAddress = { address: string; family: number };

// Same shape as node:net's LookupFunction, restricted to the "all" form so the
// caller always gets back a list of candidates rather than juggling two shapes.
export type LinkFetchLookup = (
  hostname: string,
  options: dns.LookupAllOptions,
  callback: (err: NodeJS.ErrnoException | null, addresses: dns.LookupAddress[]) => void,
) => void;

const defaultLookup: LinkFetchLookup = (hostname, options, callback) => {
  dns.lookup(hostname, options, callback);
};

function resolveAddress(hostname: string, lookup: LinkFetchLookup): Promise<ResolvedAddress> {
  const literalFamily = net.isIP(hostname);
  if (literalFamily) return Promise.resolve({ address: hostname, family: literalFamily });

  return new Promise((resolve, reject) => {
    lookup(hostname, { all: true }, (err, addresses) => {
      if (err) {
        reject(linkRefused(`could not resolve "${hostname}"`));
        return;
      }
      const first = addresses[0];
      if (!first) {
        reject(linkRefused(`"${hostname}" resolved to no address at all`));
        return;
      }
      resolve(first);
    });
  });
}

// The whole point of this module: whatever hostname or DNS answer the real connect
// step is handed, it always gets back the one address that was already checked. This
// is what stops a second DNS answer, returned only at connect time, from ever being
// the address DocMind's server actually talks to.
export function pinnedLookup(resolved: ResolvedAddress): net.LookupFunction {
  return (_hostname, options, callback) => {
    const wantsAll = typeof options === "object" && options !== null && "all" in options && options.all;
    if (wantsAll) callback(null, [{ address: resolved.address, family: resolved.family }]);
    else callback(null, resolved.address, resolved.family);
  };
}

function buildPinnedDispatcher(resolved: ResolvedAddress): Agent {
  return new Agent({ connect: { lookup: pinnedLookup(resolved) } });
}

// Reads a stream up to a byte cap, refusing once the cap is crossed instead of after
// the whole body has been pulled into memory. content-length is never trusted: a
// response can lie about it, or omit it and stream forever.
export async function readCappedBody(stream: Readable, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const piece = chunk as Buffer;
    total += piece.length;
    if (total > maxBytes) {
      stream.destroy();
      throw linkRefused(`the response is larger than the ${Math.floor(maxBytes / (1024 * 1024))} MB limit`);
    }
    chunks.push(piece);
  }
  return Buffer.concat(chunks);
}

function contentTypeOf(response: UndiciResponse): string {
  const header = response.headers.get("content-type") ?? "";
  return header.split(";")[0]!.trim().toLowerCase();
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

// Readability is built for articles. A bank statement or a plain listing page has no
// "article" by its heuristics but still has text worth keeping, so a blank result
// falls back to the page's own text content rather than an empty document.
function extractReadableText(html: string): { title: string; text: string } {
  const { document } = parseHTML(html);
  const reader = new Readability(document as unknown as Document);
  const article = reader.parse();
  const articleText = article?.textContent?.trim();
  if (articleText) return { title: article?.title?.trim() ?? "", text: articleText };

  const fallbackText = (document.body?.textContent ?? "").trim();
  const fallbackTitle = document.title?.trim() ?? "";
  return { title: fallbackTitle, text: fallbackText };
}

export async function fetchReadablePage({
  url,
  dispatcher,
  lookup = defaultLookup,
}: {
  url: string;
  dispatcher?: Dispatcher;
  lookup?: LinkFetchLookup;
}): Promise<{ title: string; text: string; finalUrl: string }> {
  const deadline = AbortSignal.timeout(TIMEOUT_MS);
  let currentUrl = assertFetchableUrl(url);
  let redirects = 0;

  while (true) {
    const resolved = await resolveAddress(currentUrl.hostname, lookup);
    if (!isPublicAddress(resolved.address)) {
      throw linkRefused(`"${currentUrl.hostname}" resolves to an address that is not public`);
    }

    const ownDispatcher = dispatcher ? undefined : buildPinnedDispatcher(resolved);
    const hopDispatcher = dispatcher ?? ownDispatcher!;
    let response: UndiciResponse;
    try {
      response = await undiciFetch(currentUrl.toString(), {
        dispatcher: hopDispatcher,
        redirect: "manual",
        signal: deadline,
      });
    } finally {
      if (ownDispatcher) await ownDispatcher.close();
    }

    if (isRedirectStatus(response.status)) {
      redirects += 1;
      if (redirects > MAX_REDIRECTS) throw linkRefused(`too many redirects fetching ${url}`);
      const location = response.headers.get("location");
      if (!location) throw linkRefused(`redirect from ${currentUrl.toString()} carried no location`);
      currentUrl = assertFetchableUrl(new URL(location, currentUrl).toString());
      continue;
    }

    if (!response.ok) {
      throw linkRefused(`${currentUrl.toString()} answered with status ${response.status}`);
    }

    const contentType = contentTypeOf(response);
    if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
      throw linkRefused(`"${contentType || "unknown"}" content is not something DocMind can read as a page`);
    }

    const body = response.body ? Readable.fromWeb(response.body as unknown as WebReadableStream) : Readable.from([]);
    const buffer = await readCappedBody(body, MAX_BODY_BYTES);
    const text = buffer.toString("utf-8");

    if (contentType === "text/plain") {
      return { title: "", text, finalUrl: currentUrl.toString() };
    }
    const { title, text: readableText } = extractReadableText(text);
    return { title, text: readableText, finalUrl: currentUrl.toString() };
  }
}
