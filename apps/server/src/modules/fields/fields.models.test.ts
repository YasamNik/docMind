import { describe, expect, it } from "vitest";
import { FIELDS_PROMPT_SECTION, normalizeFieldRow, normalizeFieldRows } from "./fields.models.js";
import { DOCUMENT_TYPES, FIELD_KEYS, FIELD_STATUSES } from "./fields.types.js";

describe("normalizeFieldRow", () => {
  it("keeps a valid documentType", () => {
    expect(normalizeFieldRow({ key: "documentType", value: "invoice", confidence: 0.9 })).toEqual({
      key: "documentType",
      value: "invoice",
      valueNumber: null,
      valueDate: null,
      currency: null,
      confidence: 0.9,
    });
  });

  it("lowercases and trims a documentType before checking the enum", () => {
    expect(normalizeFieldRow({ key: "documentType", value: " Invoice " })?.value).toBe("invoice");
  });

  it("drops a documentType outside the enum", () => {
    expect(normalizeFieldRow({ key: "documentType", value: "spaceship" })).toBeNull();
  });

  it("drops an unknown key", () => {
    expect(normalizeFieldRow({ key: "vendorName", value: "Acme" })).toBeNull();
  });

  it("parses an amount and keeps its currency", () => {
    expect(normalizeFieldRow({ key: "amountTotal", value: "1,234.56", currency: "usd" })).toEqual({
      key: "amountTotal",
      value: "1,234.56",
      valueNumber: 1234.56,
      valueDate: null,
      currency: "USD",
      confidence: null,
    });
  });

  it("drops an amount that is not numeric", () => {
    expect(normalizeFieldRow({ key: "amountTotal", value: "several hundred" })).toBeNull();
  });

  it("drops a currency that is not three letters, keeping the amount", () => {
    expect(normalizeFieldRow({ key: "amountTotal", value: "10.00", currency: "dollars" })).toEqual({
      key: "amountTotal",
      value: "10.00",
      valueNumber: 10,
      valueDate: null,
      currency: null,
      confidence: null,
    });
  });

  it("keeps a valid status and lowercases it", () => {
    expect(normalizeFieldRow({ key: "status", value: "Paid" })?.value).toBe("paid");
  });

  it("drops a status outside the enum, so an inferred guess never lands", () => {
    expect(normalizeFieldRow({ key: "status", value: "probably unpaid" })).toBeNull();
  });

  it("parses taxAmount the same way as amountTotal, with its own currency", () => {
    expect(normalizeFieldRow({ key: "taxAmount", value: "18.50", currency: "eur" })).toEqual({
      key: "taxAmount",
      value: "18.50",
      valueNumber: 18.5,
      valueDate: null,
      currency: "EUR",
      confidence: null,
    });
  });

  it("treats periodStart and periodEnd as dates", () => {
    expect(normalizeFieldRow({ key: "periodStart", value: "2026-01-01" })?.valueDate).toBe("2026-01-01");
    expect(normalizeFieldRow({ key: "periodEnd", value: "2026-12-31" })?.valueDate).toBe("2026-12-31");
    expect(normalizeFieldRow({ key: "periodEnd", value: "whenever" })).toBeNull();
  });

  it("keeps the new text keys as plain text", () => {
    expect(normalizeFieldRow({ key: "personName", value: "Jane Doe" })?.value).toBe("Jane Doe");
    expect(normalizeFieldRow({ key: "paymentMethod", value: "card ending 4821" })?.value).toBe("card ending 4821");
    expect(normalizeFieldRow({ key: "accountNumber", value: "ACC-99120" })?.value).toBe("ACC-99120");
    expect(normalizeFieldRow({ key: "location", value: "12 King St, Toronto" })?.value).toBe("12 King St, Toronto");
  });

  it("keeps a valid date and mirrors it into valueDate", () => {
    expect(normalizeFieldRow({ key: "dueDate", value: "2026-03-01" })).toEqual({
      key: "dueDate",
      value: "2026-03-01",
      valueNumber: null,
      valueDate: "2026-03-01",
      currency: null,
      confidence: null,
    });
  });

  it("drops an unparseable date", () => {
    expect(normalizeFieldRow({ key: "expiryDate", value: "next Tuesday" })).toBeNull();
  });

  it("drops a date that is well formed but not a real calendar day", () => {
    expect(normalizeFieldRow({ key: "dueDate", value: "2026-02-31" })).toBeNull();
  });

  it("drops an empty value", () => {
    expect(normalizeFieldRow({ key: "counterparty", value: "   " })).toBeNull();
  });

  it("drops a non-string value", () => {
    expect(normalizeFieldRow({ key: "counterparty", value: 42 })).toBeNull();
  });

  it("ignores a confidence outside zero to one", () => {
    expect(normalizeFieldRow({ key: "counterparty", value: "Acme", confidence: 5 })?.confidence).toBeNull();
  });

  it("truncates an over long text value rather than dropping it", () => {
    const long = "a".repeat(500);
    expect(normalizeFieldRow({ key: "counterparty", value: long })?.value).toHaveLength(200);
  });
});

describe("normalizeFieldRows", () => {
  it("keeps the good rows and reports the dropped ones", () => {
    const result = normalizeFieldRows([
      { key: "documentType", value: "receipt" },
      { key: "nonsense", value: "x" },
      { key: "counterparty", value: "Acme Ltd" },
    ]);
    expect(result.fields.map((f) => f.key)).toEqual(["documentType", "counterparty"]);
    expect(result.dropped).toEqual([{ key: "nonsense", reason: "unknown key" }]);
  });

  it("keeps only the first row for a repeated key, since the table is unique per key", () => {
    const result = normalizeFieldRows([
      { key: "counterparty", value: "First" },
      { key: "counterparty", value: "Second" },
    ]);
    expect(result.fields).toHaveLength(1);
    expect(result.fields[0]!.value).toBe("First");
    expect(result.dropped).toEqual([{ key: "counterparty", reason: "duplicate key" }]);
  });

  it("returns nothing for a non array", () => {
    expect(normalizeFieldRows(undefined as unknown as unknown[]).fields).toEqual([]);
  });
});

describe("FIELDS_PROMPT_SECTION", () => {
  it("names every key so the model knows the whole vocabulary", () => {
    for (const key of FIELD_KEYS) expect(FIELDS_PROMPT_SECTION).toContain(key);
  });

  it("names every document type", () => {
    for (const type of DOCUMENT_TYPES) expect(FIELDS_PROMPT_SECTION).toContain(type);
  });

  it("names every status", () => {
    for (const status of FIELD_STATUSES) expect(FIELDS_PROMPT_SECTION).toContain(status);
  });

  it("tells the model not to write full card or identifier numbers", () => {
    expect(FIELDS_PROMPT_SECTION).toContain("Never write a full card number");
  });

  it("states the counterparty rule of thumb", () => {
    expect(FIELDS_PROMPT_SECTION.toLowerCase()).toContain("not the owner");
  });
});
