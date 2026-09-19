import * as v from "valibot";
import { defineSetting } from "../settings/settings.registry.js";
import type { SettingDefinition } from "../settings/settings.types.js";

// The token is the one thing a person types in, from BotFather, so it is the only
// setting here that is not internal. Everything else is state the pairing flow and
// the poll loop keep for themselves, kept off the generic settings form the same way
// ai.embedding.activeDimension is.
export const telegramSettingDefinitions: SettingDefinition[] = [
  defineSetting({
    key: "telegram.botToken",
    schema: v.pipe(v.string(), v.minLength(1)),
    secret: true,
    doc: "Token for the Telegram bot, from BotFather.",
  }),
  defineSetting({
    key: "telegram.pairedUserId",
    schema: v.number(),
    internal: true,
    doc: "The one Telegram user id this bot answers to. Set by the pairing flow, unset before pairing.",
  }),
  defineSetting({
    key: "telegram.pairingCode",
    schema: v.string(),
    internal: true,
    default: "",
    doc: "Current pairing code shown in Settings, cleared once a pairing succeeds.",
  }),
  defineSetting({
    key: "telegram.pairedName",
    schema: v.string(),
    internal: true,
    default: "",
    doc: "Display name of the Telegram user this bot is paired with, captured at pairing time.",
  }),
  defineSetting({
    key: "telegram.lastUpdateId",
    schema: v.number(),
    internal: true,
    default: 0,
    doc: "The last Telegram update id the poll loop has handled.",
  }),
  defineSetting({
    key: "telegram.lastReportedAt",
    schema: v.string(),
    internal: true,
    default: "",
    doc: "Timestamp of the newest telegram-sourced document already announced by the second reply.",
  }),
  defineSetting({
    key: "telegram.lastReportedId",
    schema: v.string(),
    internal: true,
    default: "",
    doc: "Id of the document at telegram.lastReportedAt, so two documents that share that exact timestamp cannot make the second one invisible to the watermark forever.",
  }),
  // Not in the original spec table: the compressed-photo notice must be said once
  // ever, not once per process, so it needs its own persisted flag. Settings are a
  // plain key/value store, so this needs no migration, the same reasoning the AI
  // module uses for its per-provider "enabled" flags.
  defineSetting({
    key: "telegram.compressedPhotoNoticeSent",
    schema: v.boolean(),
    internal: true,
    default: false,
    doc: "Whether the bot has already warned once that Telegram compresses photos sent as photos.",
  }),
  // Same once-only shape as compressedPhotoNoticeSent above: plain text used to file a
  // note, and someone mid-habit of texting notes should be told once, not every time.
  defineSetting({
    key: "telegram.noteMigrationNoticeSent",
    schema: v.boolean(),
    internal: true,
    default: false,
    doc: "Whether the bot has already said once that notes moved behind /note.",
  }),
  // One Telegram chat maps to one active chat session, the same session model the
  // app's own chat page uses, so a conversation held on the phone is visible there
  // too. Cleared to "" by /new, which is what starts a fresh one on the next turn.
  defineSetting({
    key: "telegram.chatSessionId",
    schema: v.string(),
    internal: true,
    default: "",
    doc: "Id of the active chat session for the paired Telegram conversation, cleared by /new.",
  }),
];
