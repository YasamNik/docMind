import type { ExtractedField } from "./documents-api";
import { formatDocumentDate } from "./format";

// Mirrors the server's controlled key vocabulary (fields.types.ts). Kept as a client
// side copy rather than an import, since the client never imports server modules.
export const FIELD_KEYS = [
  "documentType",
  "counterparty",
  "personName",
  "amountTotal",
  "taxAmount",
  "paymentMethod",
  "status",
  "accountNumber",
  "referenceNumber",
  "dueDate",
  "expiryDate",
  "periodStart",
  "periodEnd",
  "location",
] as const;

export type FieldKey = (typeof FIELD_KEYS)[number];

// Human labels for the field keys, used by both the document detail page and the
// documents table filter, so the two never drift into different wording.
export const FIELD_KEY_LABELS: Record<FieldKey, string> = {
  documentType: "Type",
  counterparty: "Counterparty",
  personName: "Person",
  amountTotal: "Total",
  taxAmount: "Tax",
  paymentMethod: "Payment method",
  status: "Status",
  accountNumber: "Account number",
  referenceNumber: "Reference",
  dueDate: "Due",
  expiryDate: "Expires",
  periodStart: "Period start",
  periodEnd: "Period end",
  location: "Location",
};

const AMOUNT_KEYS = new Set<FieldKey>(["amountTotal", "taxAmount"]);
const DATE_KEYS = new Set<FieldKey>(["dueDate", "expiryDate", "periodStart", "periodEnd"]);
// documentType and status are stored lowercase, so they read better capitalized.
const CAPITALIZED_KEYS = new Set<FieldKey>(["documentType", "status"]);

function capitalize(value: string): string {
  return value.length === 0 ? value : value[0]!.toUpperCase() + value.slice(1);
}

export function fieldLabel(key: string): string {
  return (FIELD_KEY_LABELS as Record<string, string>)[key] ?? key;
}

export function isAmountFieldKey(key: string): boolean {
  return AMOUNT_KEYS.has(key as FieldKey);
}

export function formatFieldValue(field: ExtractedField): string {
  const key = field.key as FieldKey;
  if (DATE_KEYS.has(key) && field.valueDate) return formatDocumentDate(field.valueDate);
  if (CAPITALIZED_KEYS.has(key)) return capitalize(field.value);
  return field.value;
}
