import {
  AMOUNT_KEYS,
  DATE_KEYS,
  DOCUMENT_TYPES,
  FIELD_KEYS,
  FIELD_STATUSES,
  type FieldKey,
  type NormalizedField,
} from "./fields.types.js";

// Also the ceiling that stops a model ignoring the masking instruction from dumping a
// page of text into a personal data field.
const TEXT_VALUE_LIMIT = 200;

// The model is told the vocabulary here. The reply schema deliberately does not enforce
// any of it: generateStructured parses the whole reply as one object and throws on any
// nested failure, so a single invented key would take the summary down with it. Every
// rule below is checked after parsing instead, in normalizeFieldRow.
export const FIELDS_PROMPT_SECTION = `Also extract the following facts, as a "fields" array. Include an entry only when the
document actually states it. Omit anything you would have to guess at. Most documents
will fill only a few of these, which is expected.

- documentType: one of ${DOCUMENT_TYPES.join(", ")}.
- counterparty: the organisation or person who is not the owner of this collection: the
  vendor, merchant, airline, landlord, clinic, insurer, or employer. On a document the
  owner received that is the sender or issuer. On one the owner wrote it is the
  addressee. Omit it when there is no second party.
- personName: the person the document is about, such as the patient, traveller, passport
  holder, insured person, or employee. This is a person, not an organisation.
- amountTotal: the headline total, not a line item. Give the number as it appears and put
  its ISO 4217 code in "currency", for example USD or EUR.
- taxAmount: VAT, GST, or sales tax, only when stated separately from the total. Same
  currency handling as amountTotal.
- paymentMethod: how it was paid, in masked form only, for example "card ending 4821" or
  "bank transfer".
- status: one of ${FIELD_STATUSES.join(", ")}, only when the document states it. Do not
  infer that a bill is unpaid just because it does not say paid.
- accountNumber: an account that persists across documents, such as a utility or bank
  account number. Not this document's own reference.
- referenceNumber: this document's own identifier: invoice number, booking reference,
  policy number, or passport number.
- dueDate: when payment or action is due, as YYYY-MM-DD.
- expiryDate: when the document or its cover stops being valid, as YYYY-MM-DD.
- periodStart and periodEnd: the period the document covers, as YYYY-MM-DD. A billing
  period, a hotel stay, a lease term, an insurance year, or a tax year.
- location: the property address, travel destination, or place of service.

Never write a full card number, a full social insurance or social security number, or a
full national tax identifier. Give the masked or partial form, or omit the field.

Each entry is { "key": ..., "value": ..., "currency": ... or null, "confidence": 0 to 1 }.`;

function isRealCalendarDay(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [, y, m, d] = match;
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return false;
  // Rejects 2026-02-31, which Date rolls forward into March rather than refusing.
  return (
    date.getUTCFullYear() === Number(y) && date.getUTCMonth() + 1 === Number(m) && date.getUTCDate() === Number(d)
  );
}

function parseAmount(value: string): number | null {
  // Accepts "1,234.56" and "1234.56". Anything with letters or no digits is not an amount.
  const cleaned = value.replace(/[\s,]/g, "");
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function normalizeConfidence(raw: unknown): number | null {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return null;
  if (raw < 0 || raw > 1) return null;
  return raw;
}

export function normalizeFieldRow(row: {
  key: unknown;
  value: unknown;
  currency?: unknown;
  confidence?: unknown;
}): NormalizedField | null {
  if (typeof row.key !== "string") return null;
  const key = row.key.trim() as FieldKey;
  if (!(FIELD_KEYS as readonly string[]).includes(key)) return null;

  if (typeof row.value !== "string") return null;
  const trimmed = row.value.trim();
  if (trimmed.length === 0) return null;

  const confidence = normalizeConfidence(row.confidence);
  const base: NormalizedField = {
    key,
    value: trimmed.slice(0, TEXT_VALUE_LIMIT),
    valueNumber: null,
    valueDate: null,
    currency: null,
    confidence,
  };

  if (key === "documentType") {
    const lowered = trimmed.toLowerCase();
    if (!(DOCUMENT_TYPES as readonly string[]).includes(lowered)) return null;
    return { ...base, value: lowered };
  }

  if (key === "status") {
    const lowered = trimmed.toLowerCase();
    if (!(FIELD_STATUSES as readonly string[]).includes(lowered)) return null;
    return { ...base, value: lowered };
  }

  if (AMOUNT_KEYS.includes(key)) {
    const amount = parseAmount(trimmed);
    if (amount === null) return null;
    const rawCurrency = typeof row.currency === "string" ? row.currency.trim().toUpperCase() : "";
    // A bad currency loses the currency, never the amount.
    const currency = /^[A-Z]{3}$/.test(rawCurrency) ? rawCurrency : null;
    return { ...base, valueNumber: amount, currency };
  }

  if (DATE_KEYS.includes(key)) {
    if (!isRealCalendarDay(trimmed)) return null;
    return { ...base, valueDate: trimmed };
  }

  return base;
}

export function normalizeFieldRows(rows: unknown[]): {
  fields: NormalizedField[];
  dropped: { key: string; reason: string }[];
} {
  if (!Array.isArray(rows)) return { fields: [], dropped: [] };

  const fields: NormalizedField[] = [];
  const dropped: { key: string; reason: string }[] = [];
  const seen = new Set<string>();

  for (const raw of rows) {
    if (typeof raw !== "object" || raw === null) {
      dropped.push({ key: "", reason: "not an object" });
      continue;
    }
    const row = raw as { key?: unknown; value?: unknown; currency?: unknown; confidence?: unknown };
    const label = typeof row.key === "string" ? row.key : "";
    const normalized = normalizeFieldRow({
      key: row.key,
      value: row.value,
      currency: row.currency,
      confidence: row.confidence,
    });
    if (!normalized) {
      dropped.push({ key: label, reason: (FIELD_KEYS as readonly string[]).includes(label) ? "invalid value" : "unknown key" });
      continue;
    }
    // The table is unique on (document_id, key), so a repeat would collide on write.
    if (seen.has(normalized.key)) {
      dropped.push({ key: normalized.key, reason: "duplicate key" });
      continue;
    }
    seen.add(normalized.key);
    fields.push(normalized);
  }

  return { fields, dropped };
}
