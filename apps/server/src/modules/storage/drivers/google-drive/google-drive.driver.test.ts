import { Readable } from "node:stream";
import { OAuth2Client } from "google-auth-library";
import { describe, expect, it, vi } from "vitest";
import { createTestDatabase } from "../../../../shared/test/database.test-utils.js";
import { expectAppError } from "../../../../shared/test/errors.test-utils.js";
import { createSettingsRegistry } from "../../../settings/settings.registry.js";
import { createSettingsService } from "../../../settings/settings.usecases.js";
import { runDriverContractTests } from "../driver-contract.test-utils.js";
import { createGoogleDriveClient, RESUMABLE_CHUNK_SIZE_BYTES, type DriveFetch } from "./google-drive.client.js";
import { createGoogleDriveDriver, describeGoogleDriveLocation, googleDriveDriverDefinition } from "./google-drive.driver.js";

const DRIVE_UPLOAD_BASE = "https://www.googleapis.com/upload/drive/v3/files";
const RESUMABLE_QUERY_PARAM = "upload_id";

function splitMultipart(buffer: Buffer, boundary: string) {
  const marker = Buffer.from(`--${boundary}`);
  const raw: Buffer[] = [];
  let start = buffer.indexOf(marker);
  while (start !== -1) {
    const next = buffer.indexOf(marker, start + marker.length);
    if (next === -1) break;
    let part = buffer.subarray(start + marker.length, next);
    if (part.subarray(0, 2).toString("latin1") === "\r\n") part = part.subarray(2);
    if (part.subarray(-2).toString("latin1") === "\r\n") part = part.subarray(0, -2);
    raw.push(part);
    start = next;
  }
  return raw.map((part) => {
    const headerEnd = part.indexOf(Buffer.from("\r\n\r\n"));
    return { content: part.subarray(headerEnd + 4) };
  });
}

// A fake Drive that speaks only the REST subset the client actually calls: files
// create (folders), files list (folder search), the two upload paths, files get (both
// metadata and alt=media), files delete and about get. Unhandled requests throw, naming
// the URL, so a call the client should not be making fails loudly rather than silently.
function createFakeGoogleDrive() {
  const files = new Map<string, { name: string; body: Buffer; parents: string[] }>();
  const pendingSessions = new Map<string, { name: string; parents: string[]; chunks: Buffer[]; receivedBytes: number }>();
  const sessions = { completed: 0 };
  let nextId = 1;
  const newId = () => `file-${nextId++}`;

  const fetchImpl: DriveFetch = (async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const headers = (init?.headers ?? {}) as Record<string, string>;

    if (method === "GET" && url.pathname === "/drive/v3/about") {
      return new Response(JSON.stringify({ user: { emailAddress: "someone@example.com" } }), { status: 200 });
    }

    if (method === "POST" && url.pathname === "/drive/v3/files") {
      const body = JSON.parse(String(init?.body)) as { name: string; parents?: string[] };
      const id = newId();
      files.set(id, { name: body.name, body: Buffer.alloc(0), parents: body.parents ?? [] });
      return new Response(JSON.stringify({ id }), { status: 200 });
    }

    if (method === "GET" && url.pathname === "/drive/v3/files") {
      return new Response(JSON.stringify({ files: [] }), { status: 200 });
    }

    if (method === "POST" && url.pathname === "/upload/drive/v3/files" && url.searchParams.get("uploadType") === "multipart") {
      const contentType = headers["Content-Type"] ?? "";
      const boundary = /boundary=(.+)$/.exec(contentType)?.[1];
      if (!boundary) throw new Error(`Fake Google Drive received a multipart upload without a boundary: ${contentType}`);
      const parts = splitMultipart(Buffer.from(init!.body as Buffer), boundary);
      const metadata = JSON.parse(parts[0]!.content.toString("utf8")) as { name: string; parents?: string[] };
      const id = newId();
      files.set(id, { name: metadata.name, body: parts[1]!.content, parents: metadata.parents ?? [] });
      return new Response(JSON.stringify({ id }), { status: 200 });
    }

    if (method === "POST" && url.pathname === "/upload/drive/v3/files" && url.searchParams.get("uploadType") === "resumable") {
      const metadata = JSON.parse(String(init?.body)) as { name: string; parents?: string[] };
      const sessionId = `session-${nextId++}`;
      pendingSessions.set(sessionId, { name: metadata.name, parents: metadata.parents ?? [], chunks: [], receivedBytes: 0 });
      return new Response(null, {
        status: 200,
        headers: { Location: `${DRIVE_UPLOAD_BASE}?uploadType=resumable&${RESUMABLE_QUERY_PARAM}=${sessionId}` },
      });
    }

    if (method === "PUT" && url.pathname === "/upload/drive/v3/files" && url.searchParams.has(RESUMABLE_QUERY_PARAM)) {
      const sessionId = url.searchParams.get(RESUMABLE_QUERY_PARAM)!;
      const session = pendingSessions.get(sessionId);
      if (!session) throw new Error(`Fake Google Drive received a chunk for an unknown session "${sessionId}"`);
      const range = headers["Content-Range"] ?? "";
      const match = /^bytes (?:(\d+)-(\d+)|\*)\/(\d+|\*)$/.exec(range);
      if (!match) throw new Error(`Fake Google Drive received a chunk with an unreadable Content-Range: "${range}"`);
      const chunk = Buffer.from((init?.body as Buffer) ?? Buffer.alloc(0));
      session.chunks.push(chunk);
      session.receivedBytes += chunk.length;
      const total = match[3];
      if (total !== "*") {
        const id = newId();
        files.set(id, { name: session.name, body: Buffer.concat(session.chunks), parents: session.parents });
        pendingSessions.delete(sessionId);
        sessions.completed += 1;
        return new Response(JSON.stringify({ id }), { status: 200 });
      }
      return new Response(null, { status: 308 });
    }

    const fileMatch = /^\/drive\/v3\/files\/([^/]+)$/.exec(url.pathname);
    if (fileMatch) {
      const id = decodeURIComponent(fileMatch[1]!);
      const file = files.get(id);
      if (method === "GET" && url.searchParams.get("alt") === "media") {
        if (!file) return new Response(null, { status: 404 });
        return new Response(file.body, { status: 200 });
      }
      if (method === "GET") {
        if (!file) return new Response(null, { status: 404 });
        return new Response(JSON.stringify({ id, name: file.name }), { status: 200 });
      }
      if (method === "DELETE") {
        files.delete(id);
        return new Response(null, { status: 204 });
      }
    }

    throw new Error(`Fake Google Drive received an unhandled request: ${method} ${url.toString()}`);
  }) as DriveFetch;

  return { fetchImpl, files, sessions };
}

function makeDriverWithFakeDrive() {
  const { fetchImpl, files, sessions } = createFakeGoogleDrive();
  const drive = createGoogleDriveClient({ getAccessToken: async () => "fake-access-token", fetchImpl });
  const driver = createGoogleDriveDriver({ drive, resolveFolderId: async () => "root-folder-id" });
  return { driver, drive, files, sessions, describeLocation: describeGoogleDriveLocation };
}

runDriverContractTests("google-drive", async () => makeDriverWithFakeDrive());

describe("google drive driver extras", () => {
  it("uploads a body over five megabytes through a resumable session", async () => {
    const { driver, sessions } = makeDriverWithFakeDrive();
    await driver.put({ key: "big.bin", body: Readable.from([Buffer.alloc(6 * 1024 * 1024, "x")]) });
    expect(sessions.completed).toBe(1);
  });

  it("keeps small uploads on the single request path", async () => {
    const { driver, sessions } = makeDriverWithFakeDrive();
    await driver.put({ key: "small.txt", body: Readable.from(["hello"]) });
    expect(sessions.completed).toBe(0);
  });

  // uploadResumable does not retry a failed chunk or resume the session: it surfaces the
  // first chunk that answers with neither 308 nor 200 as a clean error and stops. This
  // locks that gap in as current behavior rather than an accident nobody noticed.
  it("surfaces a chunk failure partway through a resumable upload as a clean error, with no retry", async () => {
    let putCount = 0;
    const fetchImpl: DriveFetch = (async (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      if (method === "POST" && url.pathname === "/upload/drive/v3/files" && url.searchParams.get("uploadType") === "resumable") {
        return new Response(null, {
          status: 200,
          headers: { Location: `${DRIVE_UPLOAD_BASE}?uploadType=resumable&${RESUMABLE_QUERY_PARAM}=session-fail` },
        });
      }
      if (method === "PUT" && url.pathname === "/upload/drive/v3/files") {
        putCount += 1;
        // First chunk of three: accepted, more to come. Second chunk: fails outright,
        // mid upload, well before the final chunk. Third chunk must never be sent.
        if (putCount === 1) return new Response(null, { status: 308 });
        return new Response("rate limited", { status: 500 });
      }
      throw new Error(`Unexpected request in this test: ${method} ${url.toString()}`);
    }) as DriveFetch;

    const drive = createGoogleDriveClient({ getAccessToken: async () => "fake-access-token", fetchImpl });
    const driver = createGoogleDriveDriver({ drive, resolveFolderId: async () => "root-folder-id" });

    const body = Readable.from([Buffer.alloc(2 * RESUMABLE_CHUNK_SIZE_BYTES + 1024, "x")]);
    await expectAppError(() => driver.put({ key: "big.bin", body }), "storage.google_drive_error");
    expect(putCount).toBe(2);
  });

  it("describes a file as a Drive link without a network call", () => {
    expect(describeGoogleDriveLocation({ key: "1a2b3c" })).toEqual({
      label: "Google Drive file 1a2b3c",
      url: "https://drive.google.com/file/d/1a2b3c/view",
    });
  });

  it("uploads a file into the resolved folder", async () => {
    const { driver, files } = makeDriverWithFakeDrive();
    const { key } = await driver.put({ key: "notes/report.pdf", body: Readable.from(["hi"]), mimeType: "application/pdf" });
    expect(files.get(key)).toMatchObject({ name: "report.pdf", parents: ["root-folder-id"] });
  });

  it("passes a healthy write and cleans up its probe file", async () => {
    const { driver, files } = makeDriverWithFakeDrive();
    const before = files.size;
    const result = await driver.healthCheck();
    expect(result).toMatchObject({ ok: true });
    expect(result.message).toContain("someone@example.com");
    expect(files.size).toBe(before);
  });

  it("reports the underlying error when Google Drive cannot be reached", async () => {
    const drive = createGoogleDriveClient({
      getAccessToken: async () => "fake-access-token",
      fetchImpl: (async () => new Response(null, { status: 500 })) as DriveFetch,
    });
    const driver = createGoogleDriveDriver({ drive, resolveFolderId: async () => "root-folder-id" });
    expect(await driver.healthCheck()).toMatchObject({ ok: false });
  });

  it("reports a missing file id as not found on download", async () => {
    const { driver } = makeDriverWithFakeDrive();
    await expectAppError(() => driver.get({ key: "does-not-exist" }), "storage.not_found");
  });
});

describe("google drive oauth hook", () => {
  it("builds an authorize url with the drive.file scope and no client secret in it", () => {
    const url = new URL(
      googleDriveDriverDefinition.oauth!.authorizeUrl({
        clientId: "client-id",
        redirectUri: "https://example.com/api/storage/drivers/googleDrive/callback",
        state: "abc.def",
      }),
    );
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("client_id")).toBe("client-id");
    expect(url.searchParams.get("redirect_uri")).toBe("https://example.com/api/storage/drivers/googleDrive/callback");
    expect(url.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/drive.file");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("state")).toBe("abc.def");
  });

  it("names the settings the generic connect and callback routes read and write", () => {
    expect(googleDriveDriverDefinition.oauth!.keys).toEqual({
      clientId: "storage.googleDrive.clientId",
      clientSecret: "storage.googleDrive.clientSecret",
      refreshToken: "storage.googleDrive.refreshToken",
      accountEmail: "storage.googleDrive.accountEmail",
    });
  });
});

// A fake GaxiosError, shaped the way google-auth-library actually throws one: the
// message and the response body carry the provider's error code, and the request
// config carries whatever the library sent, secrets included. None of that may reach an
// AppError this code throws.
function fakeInvalidGrantError() {
  return Object.assign(new Error("invalid_grant"), {
    response: { data: { error: "invalid_grant", error_description: "Token has been expired or revoked." } },
    config: {
      url: "https://oauth2.googleapis.com/token",
      data: new URLSearchParams({ client_secret: "leaked-client-secret", refresh_token: "leaked-refresh-token" }),
    },
  });
}

describe("google drive oauth error handling", () => {
  it("turns a revoked or expired refresh token during the code exchange into a reauth prompt, with no secret in it", async () => {
    const getTokenSpy = vi.spyOn(OAuth2Client.prototype, "getToken").mockRejectedValue(fakeInvalidGrantError());
    try {
      let caught: unknown;
      try {
        await googleDriveDriverDefinition.oauth!.exchange({
          code: "bad-code",
          clientId: "client-id",
          clientSecret: "leaked-client-secret",
          redirectUri: "https://example.com/api/storage/drivers/googleDrive/callback",
        });
      } catch (error) {
        caught = error;
      }
      expect((caught as { code?: string } | undefined)?.code).toBe("storage.reauth_required");
      expect(JSON.stringify(caught)).not.toContain("leaked-client-secret");
      expect(JSON.stringify(caught)).not.toContain("leaked-refresh-token");
    } finally {
      getTokenSpy.mockRestore();
    }
  });

  it("turns an unrelated exchange failure into a generic sanitized error rather than the raw one", async () => {
    const getTokenSpy = vi.spyOn(OAuth2Client.prototype, "getToken").mockRejectedValue(new Error("fetch failed"));
    try {
      await expectAppError(
        () => googleDriveDriverDefinition.oauth!.exchange({
          code: "code",
          clientId: "client-id",
          clientSecret: "client-secret",
          redirectUri: "https://example.com/api/storage/drivers/googleDrive/callback",
        }),
        "storage.google_drive_error",
      );
    } finally {
      getTokenSpy.mockRestore();
    }
  });

  it("turns a revoked refresh token into a reauth prompt on a per request refresh, not a raw error", async () => {
    const { db } = await createTestDatabase();
    const settings = createSettingsService({
      db,
      registry: createSettingsRegistry(googleDriveDriverDefinition.settings),
      config: { settingsEncryptionKey: "22".repeat(32), env: {} },
    });
    const userId = "user-1";
    await settings.set(userId, {
      "storage.googleDrive.clientId": "client-id",
      "storage.googleDrive.clientSecret": "client-secret",
      "storage.googleDrive.refreshToken": "revoked-refresh-token",
    });
    const driver = await googleDriveDriverDefinition.create({ settings, userId });

    const getAccessTokenSpy = vi.spyOn(OAuth2Client.prototype, "getAccessToken").mockRejectedValue(fakeInvalidGrantError());
    try {
      await expectAppError(() => driver.exists({ key: "some-file-id" }), "storage.reauth_required");
    } finally {
      getAccessTokenSpy.mockRestore();
    }
  });
});

describe("google drive driver definition", () => {
  it("describes a location with no settings and no connection at all", async () => {
    const { db } = await createTestDatabase();
    const settings = createSettingsService({
      db,
      registry: createSettingsRegistry(googleDriveDriverDefinition.settings),
      config: { settingsEncryptionKey: "33".repeat(32), env: {} },
    });
    const userId = "user-1";

    // Nothing is set: the state right after Disconnect clears the refresh token and
    // account email, or before the account was ever connected. create() must refuse;
    // describeLocation must not need any of it.
    await expectAppError(() => googleDriveDriverDefinition.create({ settings, userId }), "storage.driver_not_configured");
    const location = await googleDriveDriverDefinition.describeLocation({ settings, userId, key: "1a2b3c" });
    expect(location).toEqual({
      label: "Google Drive file 1a2b3c",
      url: "https://drive.google.com/file/d/1a2b3c/view",
    });
  });
});
