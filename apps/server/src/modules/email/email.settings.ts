import * as v from "valibot";
import { defineSetting } from "../settings/settings.registry.js";
import type { SettingDefinition } from "../settings/settings.types.js";

// IMAP intake settings, in the shape telegram.settings.ts established: the handful
// of things a person types in, plus one internal field the loop keeps for itself to
// record why the last cycle did not go through, for diagnosis only.
export const emailSettingDefinitions: SettingDefinition[] = [
  defineSetting({
    key: "email.imap.host",
    schema: v.pipe(v.string(), v.minLength(1)),
    doc: "IMAP server hostname, for example imap.gmail.com.",
  }),
  defineSetting({
    key: "email.imap.port",
    schema: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(65535)),
    default: 993,
    doc: "IMAP server port.",
  }),
  defineSetting({
    key: "email.imap.user",
    schema: v.pipe(v.string(), v.minLength(1)),
    doc: "The mailbox address to sign in as.",
  }),
  defineSetting({
    key: "email.imap.password",
    schema: v.pipe(v.string(), v.minLength(1)),
    secret: true,
    doc: "An app password for the mailbox. Never the account password.",
  }),
  defineSetting({
    key: "email.imap.folder",
    schema: v.pipe(v.string(), v.minLength(1)),
    default: "DocMind",
    doc: "The folder DocMind watches for mail to take in.",
  }),
  defineSetting({
    key: "email.imap.doneFolder",
    schema: v.pipe(v.string(), v.minLength(1)),
    default: "DocMind/Done",
    doc: "Where a handled message is moved so it is never taken in twice.",
  }),
  defineSetting({
    key: "email.imap.failedFolder",
    schema: v.pipe(v.string(), v.minLength(1)),
    default: "DocMind/Failed",
    doc: "Where a message is moved after it fails to be taken in a bounded number of times.",
  }),
  defineSetting({
    key: "email.imap.pollSeconds",
    schema: v.pipe(v.number(), v.integer(), v.minValue(1)),
    default: 60,
    doc: "How often the watched folder is checked.",
  }),
  defineSetting({
    key: "email.imap.maxMessageSizeMb",
    schema: v.pipe(v.number(), v.integer(), v.minValue(1)),
    default: 25,
    // mailparser reads a whole message into memory before the upload path sees any of
    // it, so this is what actually bounds peak memory per message, not the upload
    // path's own size cap. Checked against what IMAP reports before the message is
    // downloaded at all: a message over this is moved to Failed without being fetched.
    doc: "Messages larger than this are moved to Failed without being downloaded.",
  }),
  defineSetting({
    key: "email.imap.lastError",
    schema: v.string(),
    internal: true,
    default: "",
    doc: "The reason the last cycle failed, if it did. Kept for diagnosis only; nothing surfaces it yet.",
  }),
  // Gmail over OAuth, in the shape storage's Google Drive driver settings established:
  // secret where it matters, not internal, so Disconnect is an ordinary settings write
  // of two nulls. Written by the connect flow in email.usecases.ts, never typed in.
  defineSetting({
    key: "email.gmail.refreshToken",
    schema: v.pipe(v.string(), v.minLength(1)),
    secret: true,
    doc: "Refresh token from connecting a Gmail account through Google. Written by the connect flow, never typed in.",
  }),
  defineSetting({
    key: "email.gmail.accountEmail",
    schema: v.pipe(v.string(), v.minLength(1)),
    doc: "The connected Gmail address, written by the connect flow. Also the XOAUTH2 sign-in user.",
  }),
  defineSetting({
    key: "email.gmail.clientId",
    schema: v.pipe(v.string(), v.minLength(1)),
    doc: "Optional override client id for Gmail. Leave blank to use the Google app already saved for Google Drive.",
  }),
  defineSetting({
    key: "email.gmail.clientSecret",
    schema: v.pipe(v.string(), v.minLength(1)),
    secret: true,
    doc: "Optional override client secret for Gmail. Required if the client id above is set.",
  }),
  // Read by the loop and the Test button once they classify a cycle's failure. Not
  // written yet: that lands with the loop change this settings addition prepares for.
  defineSetting({
    key: "email.imap.lastErrorCode",
    schema: v.picklist(["reauth_required", "auth_failed", "folder_missing", "network", "unknown"]),
    internal: true,
    doc: "Fixed code for the reason the last cycle failed, if it did. Drives the reconnect banner.",
  }),
];
