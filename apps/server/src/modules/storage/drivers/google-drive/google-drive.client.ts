import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { createError } from "../../../../shared/errors/errors.js";

// Drive v3 REST calls over plain fetch. No googleapis dependency: only four endpoints
// are needed (files create, files get, files delete, about get), plus the two upload
// entry points (simple and resumable) that live under the same files resource.
const DRIVE_API_BASE = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD_BASE = "https://www.googleapis.com/upload/drive/v3/files";
const FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";

// Chunk size for a resumable upload's PUT requests, so memory use stays flat whatever
// the file's total size. Must be a multiple of 256 KiB; 8 MiB matches common Drive
// client defaults.
export const RESUMABLE_CHUNK_SIZE_BYTES = 8 * 1024 * 1024;

// Narrower than the ambient, DOM-flavoured `fetch` type: only a method, a url, plain
// headers and a Buffer or string body are ever needed, and this is what the fake fetch
// in tests implements. The default value below adapts the real global fetch to it once,
// rather than fighting BodyInit's union at every call site.
export type DriveFetch = (
  url: string,
  init: { method: string; headers?: Record<string, string>; body?: Buffer | string },
) => Promise<Response>;

const defaultFetch: DriveFetch = (url, init) => fetch(url, init as RequestInit);

function driveError(message: string, status?: number) {
  return createError({ code: "storage.google_drive_error", message, status: status ?? 502 });
}

function toBuffer(value: Buffer | string) {
  return Buffer.isBuffer(value) ? value : Buffer.from(value);
}

// Every call this client makes sends either JSON text or a raw Buffer of bytes, never
// a Blob, FormData or URLSearchParams, so the body type is narrowed to what is actually
// used rather than the full, DOM-flavoured BodyInit union.
type Call = (
  method: string,
  url: string,
  init?: { headers?: Record<string, string>; body?: Buffer | string },
) => Promise<Response>;

async function createFolder(call: Call, { name, parentId }: { name: string; parentId?: string }) {
  const response = await call("POST", `${DRIVE_API_BASE}/files?fields=id`, {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, mimeType: FOLDER_MIME_TYPE, parents: parentId ? [parentId] : undefined }),
  });
  if (!response.ok) throw driveError(`Could not create the Drive folder "${name}"`, response.status);
  return (await response.json()) as { id: string };
}

async function findFolder(call: Call, { name, parentId }: { name: string; parentId?: string }) {
  const clauses = [`name = '${name.replace(/'/g, "\\'")}'`, `mimeType = '${FOLDER_MIME_TYPE}'`, "trashed = false"];
  if (parentId) clauses.push(`'${parentId}' in parents`);
  const url = new URL(`${DRIVE_API_BASE}/files`);
  url.searchParams.set("q", clauses.join(" and "));
  url.searchParams.set("fields", "files(id,name)");
  const response = await call("GET", url.toString());
  if (!response.ok) throw driveError(`Could not search for the Drive folder "${name}"`, response.status);
  const json = (await response.json()) as { files: { id: string; name: string }[] };
  return json.files[0] ? { id: json.files[0].id } : undefined;
}

// Below the resumable threshold, one multipart request carries the metadata and the
// whole body. The caller has already buffered the body up to that point, so this never
// reads more than the threshold into memory.
async function uploadSimple(
  call: Call,
  { name, parentId, mimeType, body }: { name: string; parentId: string; mimeType?: string; body: Buffer },
) {
  const boundary = `docmind-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const metadata = JSON.stringify({ name, parents: [parentId] });
  const head = Buffer.from(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n`
    + `--${boundary}\r\nContent-Type: ${mimeType || "application/octet-stream"}\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--`);

  const response = await call("POST", `${DRIVE_UPLOAD_BASE}?uploadType=multipart&fields=id`, {
    headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
    body: Buffer.concat([head, body, tail]),
  });
  if (!response.ok) throw driveError(`Could not upload "${name}" to Google Drive`, response.status);
  return (await response.json()) as { id: string };
}

// Splits an already read chunk plus the rest of a stream into fixed size pieces,
// looking one chunk ahead so the final, possibly short, piece can be marked as such
// without ever needing the total size up front.
async function* chunkStream(initial: Buffer, rest: AsyncIterable<Buffer>, chunkSize: number) {
  let buffer = initial;
  let exhausted = false;
  const iterator = rest[Symbol.asyncIterator]();

  async function fill() {
    while (buffer.length <= chunkSize && !exhausted) {
      const next = await iterator.next();
      if (next.done) {
        exhausted = true;
        break;
      }
      buffer = Buffer.concat([buffer, next.value]);
    }
  }

  await fill();
  while (buffer.length > chunkSize) {
    yield { chunk: buffer.subarray(0, chunkSize), isLast: false };
    buffer = buffer.subarray(chunkSize);
    await fill();
  }
  yield { chunk: buffer, isLast: true };
}

// Above the resumable threshold: start a session, then stream the body to it in fixed
// size chunks with the Content-Range header each one needs. Never buffers more than one
// chunk, so a large file never sits whole in memory.
async function uploadResumable(
  call: Call,
  { name, parentId, mimeType, initial, rest }: {
    name: string;
    parentId: string;
    mimeType?: string;
    initial: Buffer;
    rest: AsyncIterable<Buffer>;
  },
) {
  const startResponse = await call("POST", `${DRIVE_UPLOAD_BASE}?uploadType=resumable&fields=id`, {
    headers: {
      "Content-Type": "application/json",
      "X-Upload-Content-Type": mimeType || "application/octet-stream",
    },
    body: JSON.stringify({ name, parents: [parentId] }),
  });
  if (!startResponse.ok) throw driveError(`Could not start a resumable upload for "${name}"`, startResponse.status);
  const sessionUrl = startResponse.headers.get("location");
  if (!sessionUrl) throw driveError(`Google did not return a resumable session location for "${name}"`);

  let offset = 0;
  for await (const { chunk, isLast } of chunkStream(initial, rest, RESUMABLE_CHUNK_SIZE_BYTES)) {
    const end = offset + chunk.length - 1;
    const total = isLast ? String(offset + chunk.length) : "*";
    const range = chunk.length === 0 ? `bytes */${total}` : `bytes ${offset}-${end}/${total}`;
    const response = await call("PUT", sessionUrl, {
      headers: { "Content-Range": range, "Content-Length": String(chunk.length) },
      body: chunk,
    });

    if (isLast) {
      if (!response.ok) throw driveError(`Resumable upload for "${name}" failed to complete`, response.status);
      return (await response.json()) as { id: string };
    }
    if (response.status !== 308) throw driveError(`Resumable upload for "${name}" was rejected mid-stream`, response.status);
    offset += chunk.length;
  }
  throw driveError(`Resumable upload for "${name}" ended without a final chunk`);
}

async function getFileMetadata(call: Call, { id }: { id: string }) {
  const response = await call("GET", `${DRIVE_API_BASE}/files/${encodeURIComponent(id)}?fields=id,name`);
  if (response.status === 404) return undefined;
  if (!response.ok) throw driveError(`Could not read Drive file "${id}"`, response.status);
  return (await response.json()) as { id: string; name: string };
}

async function downloadFile(call: Call, { id }: { id: string }): Promise<Readable> {
  const response = await call("GET", `${DRIVE_API_BASE}/files/${encodeURIComponent(id)}?alt=media`);
  if (response.status === 404) {
    throw createError({ code: "storage.not_found", message: `No file at key "${id}"`, status: 404 });
  }
  if (!response.ok || !response.body) throw driveError(`Could not download Drive file "${id}"`, response.status);
  return Readable.fromWeb(response.body as WebReadableStream);
}

async function remove(call: Call, { id }: { id: string }) {
  const response = await call("DELETE", `${DRIVE_API_BASE}/files/${encodeURIComponent(id)}`);
  if (!response.ok && response.status !== 404) throw driveError(`Could not delete Drive file "${id}"`, response.status);
}

async function about(call: Call) {
  const response = await call("GET", `${DRIVE_API_BASE}/about?fields=user`);
  if (!response.ok) throw driveError("Could not reach Google Drive", response.status);
  const json = (await response.json()) as { user?: { emailAddress?: string } };
  if (!json.user?.emailAddress) throw driveError("Google Drive did not return an account email");
  return { emailAddress: json.user.emailAddress };
}

export function createGoogleDriveClient({
  getAccessToken,
  fetchImpl = defaultFetch,
}: {
  getAccessToken: () => Promise<string>;
  fetchImpl?: DriveFetch;
}) {
  const call: Call = async (method, url, init = {}) => {
    const token = await getAccessToken();
    return fetchImpl(url, {
      method,
      ...init,
      headers: { ...init.headers, Authorization: `Bearer ${token}` },
    });
  };

  return {
    createFolder: (args: { name: string; parentId?: string }) => createFolder(call, args),
    findFolder: (args: { name: string; parentId?: string }) => findFolder(call, args),
    uploadSimple: (args: { name: string; parentId: string; mimeType?: string; body: Buffer }) => uploadSimple(call, args),
    uploadResumable: (args: { name: string; parentId: string; mimeType?: string; initial: Buffer; rest: AsyncIterable<Buffer> }) =>
      uploadResumable(call, args),
    getFileMetadata: (args: { id: string }) => getFileMetadata(call, args),
    downloadFile: (args: { id: string }) => downloadFile(call, args),
    remove: (args: { id: string }) => remove(call, args),
    about: () => about(call),
  };
}

export type GoogleDriveClient = ReturnType<typeof createGoogleDriveClient>;

// Exported for the driver, which needs to turn a Node Readable's chunks (Buffer or
// string, per the Readable contract) into plain Buffers before handing them to the
// client.
export { toBuffer };
