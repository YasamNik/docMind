import { basename } from "node:path";
import type { Readable } from "node:stream";
import type { Credentials } from "google-auth-library";
import { OAuth2Client } from "google-auth-library";
import * as v from "valibot";
import { createError } from "../../../../shared/errors/errors.js";
import { defineSetting } from "../../../settings/settings.registry.js";
import type { StorageDriver, StorageDriverDefinition, StorageLocation, StorageOAuth } from "../../storage.types.js";
import { createGoogleDriveClient, toBuffer, type GoogleDriveClient } from "./google-drive.client.js";

// Google Drive storage driver. Scope is drive.file only: DocMind can read and write
// only the files it creates itself, so the app never needs Google's app verification.
// storage_key is the bare Drive file id; storage_driver already says which driver owns
// it, so no prefix is needed on the key.

const DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const DRIVE_FOLDER_NAME = "DocMind";

// A body up to this size goes through a single multipart request. Above it, a
// resumable session streams the body in chunks so a large file never sits whole in
// memory. Matches the design doc's five megabyte threshold.
const SIMPLE_UPLOAD_THRESHOLD_BYTES = 5 * 1024 * 1024;

// Reads a stream up to `limit` bytes ahead, so the caller can decide between a single
// request and a resumable session without ever buffering more than the threshold. The
// returned iterator has already been advanced by whatever was read, so the remainder of
// the stream, if any, keeps flowing from where this left off.
async function peekStream(body: Readable, limit: number) {
  const iterator = body[Symbol.asyncIterator]() as AsyncIterator<Buffer | string>;
  let buffered = Buffer.alloc(0);
  while (buffered.length <= limit) {
    const next = await iterator.next();
    if (next.done) return { buffered, exhausted: true as const, iterator };
    buffered = Buffer.concat([buffered, toBuffer(next.value)]);
  }
  return { buffered, exhausted: false as const, iterator };
}

function restOf(iterator: AsyncIterator<Buffer | string>): AsyncIterable<Buffer> {
  return {
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<Buffer>> {
          const next = await iterator.next();
          if (next.done) return { value: undefined, done: true };
          return { value: toBuffer(next.value), done: false };
        },
      };
    },
  };
}

export function createGoogleDriveDriver({
  drive,
  resolveFolderId,
}: {
  drive: GoogleDriveClient;
  resolveFolderId: () => Promise<string>;
}): StorageDriver {
  return {
    id: "googleDrive",
    async put({ key, body, mimeType }) {
      const folderId = await resolveFolderId();
      const name = basename(key) || "file";
      const { buffered, exhausted, iterator } = await peekStream(body, SIMPLE_UPLOAD_THRESHOLD_BYTES);

      const file = exhausted
        ? await drive.uploadSimple({ name, parentId: folderId, mimeType, body: buffered })
        : await drive.uploadResumable({ name, parentId: folderId, mimeType, initial: buffered, rest: restOf(iterator) });

      return { key: file.id };
    },
    async get({ key }) {
      return drive.downloadFile({ id: key });
    },
    async delete({ key }) {
      await drive.remove({ id: key });
    },
    async exists({ key }) {
      return (await drive.getFileMetadata({ id: key })) !== undefined;
    },
    async healthCheck() {
      try {
        const account = await drive.about();
        const folderId = await resolveFolderId();
        const probe = await drive.uploadSimple({
          name: `.docmind-health-${Date.now()}`,
          parentId: folderId,
          mimeType: "text/plain",
          body: Buffer.from("ok"),
        });
        await drive.remove({ id: probe.id });
        return { ok: true, message: `Connected to Google Drive as ${account.emailAddress}` };
      } catch (error) {
        return { ok: false, message: `Cannot reach Google Drive: ${(error as Error).message}` };
      }
    },
  };
}

// Pure: the label and link are built from the id alone, needing no setting, no client
// and no network call, which is what lets this answer while the driver is inactive,
// unreachable, or disconnected entirely.
export function describeGoogleDriveLocation({ key }: { key: string }): StorageLocation {
  return { label: `Google Drive file ${key}`, url: `https://drive.google.com/file/d/${key}/view` };
}

// google-auth-library surfaces a failed exchange or refresh as a GaxiosError, which
// carries the request config (headers, body) and the provider's response on properties
// our own code never touches. Left unwrapped, that object reaches the Hono error
// handler's logger whole. Every call into the library on this page is wrapped so only a
// sanitized AppError, with no property of the underlying error, ever leaves this file.
function isReauthRequired(error: unknown) {
  const failure = error as { message?: string; response?: { data?: { error?: string } } } | undefined;
  const reason = failure?.response?.data?.error ?? failure?.message;
  return reason === "invalid_grant" || reason === "invalid_token" || reason === "unauthorized_client";
}

function sanitizedGoogleAuthError(error: unknown, action: string) {
  if (isReauthRequired(error)) {
    return createError({
      code: "storage.reauth_required",
      message: `Google Drive access has expired or been revoked. Reconnect the account, then try ${action} again.`,
      status: 401,
    });
  }
  return createError({
    code: "storage.google_drive_error",
    message: `Google Drive authentication failed while ${action}.`,
    status: 502,
  });
}

const googleDriveOAuth: StorageOAuth = {
  authorizeUrl({ clientId, redirectUri, state }) {
    const client = new OAuth2Client({ clientId, redirectUri });
    return client.generateAuthUrl({
      access_type: "offline",
      prompt: "consent",
      scope: [DRIVE_FILE_SCOPE],
      state,
    });
  },
  async exchange({ code, clientId, clientSecret, redirectUri }) {
    const client = new OAuth2Client({ clientId, clientSecret, redirectUri });
    let tokens: Credentials;
    try {
      ({ tokens } = await client.getToken({ code, redirect_uri: redirectUri }));
    } catch (error) {
      throw sanitizedGoogleAuthError(error, "exchanging the authorization code");
    }

    if (!tokens.refresh_token) {
      throw createError({
        code: "storage.google_drive_no_refresh_token",
        message: "Google did not return a refresh token. Remove DocMind under the Google account's third party "
          + "access settings, then connect again so Google issues a fresh one.",
        status: 400,
      });
    }
    if (!tokens.access_token) {
      throw createError({
        code: "storage.google_drive_error",
        message: "Google did not return an access token during the exchange.",
        status: 400,
      });
    }

    const drive = createGoogleDriveClient({ getAccessToken: async () => tokens.access_token! });
    const account = await drive.about();
    return { refreshToken: tokens.refresh_token, accountEmail: account.emailAddress };
  },
  keys: {
    clientId: "storage.googleDrive.clientId",
    clientSecret: "storage.googleDrive.clientSecret",
    refreshToken: "storage.googleDrive.refreshToken",
    accountEmail: "storage.googleDrive.accountEmail",
  },
};

export const googleDriveClientIdSetting = defineSetting({
  key: "storage.googleDrive.clientId",
  schema: v.pipe(v.string(), v.minLength(1)),
  env: "STORAGE_GOOGLE_DRIVE_CLIENT_ID",
  doc: "OAuth client id from the Google Cloud project's credentials page.",
});

export const googleDriveClientSecretSetting = defineSetting({
  key: "storage.googleDrive.clientSecret",
  schema: v.pipe(v.string(), v.minLength(1)),
  env: "STORAGE_GOOGLE_DRIVE_CLIENT_SECRET",
  secret: true,
  doc: "OAuth client secret from the same credentials page.",
});

export const googleDriveRefreshTokenSetting = defineSetting({
  key: "storage.googleDrive.refreshToken",
  schema: v.pipe(v.string(), v.minLength(1)),
  secret: true,
  doc: "Refresh token from connecting a Google account. Written by the connect flow, never typed in directly.",
});

export const googleDriveAccountEmailSetting = defineSetting({
  key: "storage.googleDrive.accountEmail",
  schema: v.pipe(v.string(), v.minLength(1)),
  doc: "Email address of the connected Google account. Written by the connect flow.",
});

export const googleDriveFolderIdSetting = defineSetting({
  key: "storage.googleDrive.folderId",
  schema: v.string(),
  env: "STORAGE_GOOGLE_DRIVE_FOLDER_ID",
  default: "",
  doc: "Drive folder id DocMind stores files in. Leave blank to let DocMind create a DocMind folder on first use.",
});

export const googleDriveDriverDefinition: StorageDriverDefinition = {
  id: "googleDrive",
  label: "Google Drive",
  settings: [
    googleDriveClientIdSetting,
    googleDriveClientSecretSetting,
    googleDriveRefreshTokenSetting,
    googleDriveAccountEmailSetting,
    googleDriveFolderIdSetting,
  ],
  oauth: googleDriveOAuth,
  guide: {
    title: "Connect a Google Drive account",
    intro: "DocMind stores files in a folder it creates in your own Google Drive, with access limited to the "
      + "files it creates there. It never sees the rest of your Drive.",
    steps: [
      {
        text: "Open the Google Cloud console and create a new project for DocMind, or pick an existing one.",
        link: "https://console.cloud.google.com/projectcreate",
      },
      {
        text: "Enable the Google Drive API for that project.",
        link: "https://console.cloud.google.com/apis/library/drive.googleapis.com",
      },
      {
        text: "Configure the OAuth consent screen, then publish it. An app left in testing mode expires its "
          + "refresh tokens after seven days, so Drive access would silently stop working about a week in.",
        link: "https://console.cloud.google.com/apis/credentials/consent",
      },
      {
        text: "Create credentials of type OAuth client id, application type Web application. Paste the redirect "
          + "URI shown on this page under Authorized redirect URIs, exactly, then create the client.",
        link: "https://console.cloud.google.com/apis/credentials",
      },
      {
        text: "Copy the client id and client secret from that credential into the fields below and save them.",
      },
      {
        text: "Click Connect and sign in with the Google account whose Drive should hold DocMind's files, then "
          + "approve access.",
      },
    ],
    notes: [
      "Prefer connecting from the machine running DocMind, at localhost. A Cloudflare quick tunnel hostname "
        + "changes on restart, and the redirect URI has to already be registered in Google Cloud before a "
        + "connect made through it can succeed.",
      "Once connected, DocMind refreshes access with the stored refresh token and never touches the redirect "
        + "URI again, so a later tunnel restart does not break an existing connection.",
      "Scope is limited to files DocMind creates (drive.file). DocMind can never read or list the rest of the "
        + "Drive.",
    ],
  },
  async create({ settings, userId }) {
    const clientId = await settings.get<string>(userId, "storage.googleDrive.clientId");
    const clientSecret = await settings.get<string>(userId, "storage.googleDrive.clientSecret");
    const refreshToken = await settings.get<string>(userId, "storage.googleDrive.refreshToken");

    if (!clientId || !clientSecret || !refreshToken) {
      throw createError({
        code: "storage.driver_not_configured",
        message: "The Google Drive driver needs a client id and secret, and a completed connection, before it can be used.",
        status: 400,
      });
    }

    const authClient = new OAuth2Client({ clientId, clientSecret });
    authClient.setCredentials({ refresh_token: refreshToken });

    const drive = createGoogleDriveClient({
      getAccessToken: async () => {
        let token: string | null | undefined;
        try {
          ({ token } = await authClient.getAccessToken());
        } catch (error) {
          throw sanitizedGoogleAuthError(error, "refreshing the Google Drive access token");
        }
        if (!token) {
          throw createError({
            code: "storage.google_drive_error",
            message: "Could not refresh a Google Drive access token.",
            status: 502,
          });
        }
        return token;
      },
    });

    let cachedFolderId = (await settings.get<string>(userId, "storage.googleDrive.folderId")) || undefined;
    async function resolveFolderId() {
      if (cachedFolderId) return cachedFolderId;
      const existing = await drive.findFolder({ name: DRIVE_FOLDER_NAME });
      const folder = existing ?? (await drive.createFolder({ name: DRIVE_FOLDER_NAME }));
      cachedFolderId = folder.id;
      await settings.set(userId, { "storage.googleDrive.folderId": folder.id });
      return folder.id;
    }

    return createGoogleDriveDriver({ drive, resolveFolderId });
  },
  // Needs neither the connection nor the settings above: the key is the Drive file id,
  // and that id is all the label and link are built from.
  async describeLocation({ key }) {
    return describeGoogleDriveLocation({ key });
  },
};
