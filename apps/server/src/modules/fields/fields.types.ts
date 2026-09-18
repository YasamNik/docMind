// Deliberately generic rather than one branch per document domain. Vendor, merchant,
// airline, landlord, and insurer are all the counterparty; invoice number, booking
// reference, and policy number are all the reference number. Naming each variant would
// put forty keys in the prompt of every document, so a grocery receipt would be asked
// about lease terms.
export const FIELD_KEYS = [
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

export const FIELD_STATUSES = [
  "paid",
  "unpaid",
  "overdue",
  "confirmed",
  "cancelled",
  "active",
  "expired",
] as const;

export type FieldStatus = (typeof FIELD_STATUSES)[number];

// The keys whose value is also parsed into a typed column, so filtering and sorting do
// not have to parse text in SQL.
export const AMOUNT_KEYS: FieldKey[] = ["amountTotal", "taxAmount"];
export const DATE_KEYS: FieldKey[] = ["dueDate", "expiryDate", "periodStart", "periodEnd"];
// The keys that routinely hold personal data. The prompt requires the masked form.
export const SENSITIVE_KEYS: FieldKey[] = ["personName", "accountNumber", "paymentMethod"];

export type ExtractedField = {
  id: string;
  userId: string;
  documentId: string;
  key: FieldKey;
  value: string;
  valueNumber: number | null;
  valueDate: string | null;
  currency: string | null;
  confidence: number | null;
  source: "llm" | "manual";
  createdAt: string;
  updatedAt: string;
};

// What normalizeFieldRow returns: the storable shape without the identity and timestamps,
// which the repository fills in.
export type NormalizedField = Pick<
  ExtractedField,
  "key" | "value" | "valueNumber" | "valueDate" | "currency" | "confidence"
>;
