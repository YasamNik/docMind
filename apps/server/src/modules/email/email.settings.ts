import * as v from "valibot";
import { defineSetting } from "../settings/settings.registry.js";
import type { SettingDefinition } from "../settings/settings.types.js";

// IMAP intake settings, in the shape telegram.settings.ts established: the handful
// of things a person types in, plus one internal field the loop keeps for itself so
// the settings page can surface why the last cycle did not go through.
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
    doc: "The reason the last cycle failed, if it did. Surfaced on the settings page.",
  }),
];
