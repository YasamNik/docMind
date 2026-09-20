import { randomBytes } from "node:crypto";

export function newBudgetReceiptId() {
  return `brcpt_${randomBytes(8).toString("hex")}`;
}

export function newBudgetReceiptItemId() {
  return `britem_${randomBytes(8).toString("hex")}`;
}

export function newBudgetCategoryId() {
  return `bcat_${randomBytes(8).toString("hex")}`;
}

export function nowIso() {
  return new Date().toISOString();
}

// One vocabulary read by a receipt as a whole and by every line on it, following the
// same seeding shape as tags.models.ts's DOCUMENT_TYPE_PRESETS: read by a language model,
// so wording here changes what it decides.
export const BUDGET_CATEGORY_PRESETS: { name: string; description: string }[] = [
  { name: "Groceries", description: "Everyday food and drink for the home: pantry staples, snacks, frozen food, and general items from a supermarket or corner shop." },
  { name: "Household", description: "Things used to run and maintain a home: cleaning supplies, paper goods, laundry, batteries, and other non-food essentials." },
  { name: "Meat and fish", description: "Fresh or frozen meat, poultry, and seafood, whether from a butcher, fishmonger, or a supermarket counter." },
  { name: "Produce", description: "Fresh fruit and vegetables, whether loose, bagged, or from a market stall." },
  { name: "Bakery", description: "Bread, pastries, cakes, and other baked goods, from a bakery counter or aisle." },
  { name: "Drinks", description: "Beverages of any kind: soft drinks, juice, coffee, tea, water, and alcohol." },
  { name: "Pharmacy and health", description: "Medicine, vitamins, first aid supplies, and anything bought from a pharmacy or health shop." },
  { name: "Personal care", description: "Toiletries and grooming: soap, shampoo, skincare, cosmetics, and similar items." },
  { name: "Baby", description: "Nappies, formula, baby food, and other items for an infant or toddler." },
  { name: "Pet", description: "Pet food, litter, treats, and supplies for a cat, dog, or other animal." },
  { name: "Appliances", description: "Kitchen and household appliances, from a kettle to a washing machine." },
  { name: "Electronics", description: "Devices, cables, chargers, and other consumer electronics." },
  { name: "Clothing", description: "Clothes, shoes, and accessories for any member of the household." },
  { name: "Home and garden", description: "Furniture, decor, tools, and anything for the house, yard, or garden that is not a repeated household consumable." },
  { name: "Fuel", description: "Petrol, diesel, or other vehicle fuel bought at a pump." },
  { name: "Transport", description: "Public transport fares, parking, tolls, and ride hailing." },
  { name: "Restaurant and takeaway", description: "A meal eaten out or ordered in, from a restaurant, cafe, or takeaway." },
  { name: "Entertainment", description: "Cinema, events, games, subscriptions, and other spending on leisure." },
  { name: "Services", description: "A paid service rather than a physical good: repairs, dry cleaning, hairdressing, and similar." },
  { name: "Other", description: "Anything that does not clearly belong to another category." },
];

// A flat guard against a degenerate upload (someone stapling in fifty shots, or a bug in
// the capture sheet), not a cost control: a normal one to four photo receipt costs a
// fraction of a cent regardless of this limit. Matches MAX_STRUCTURED_IMAGES in
// ai.usecases.ts, which the vision call would refuse past anyway.
export const MAX_RECEIPT_PAGES = 10;

// Items that do not sum to the printed total is the normal case, not the error case:
// discounts, loyalty points, bottle deposits and rounding all break the sum. This is the
// tolerance past which the gap is worth a human look rather than silent rounding.
export const RECONCILE_TOLERANCE = 0.02;

// A receipt or line whose category confidence falls below this is left uncategorised
// rather than guessed at (spec section 7). One global floor, not a per-category
// threshold: budget_categories has no confidence column of its own.
export const CATEGORY_CONFIDENCE_THRESHOLD = 0.5;

const ITEM_DESCRIPTION_LIMIT = 200;

function roundMoney(amount: number): number {
  return Math.round(amount * 100) / 100;
}

function normalizeText(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

// Accepts a plain number or a numeric string ("12.50", "$12.50", "1,234.56"): the model
// sometimes formats a header amount as text even when asked for a number.
function normalizeAmount(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== "string") return null;
  const cleaned = raw.replace(/[^0-9.-]/g, "");
  if (cleaned.length === 0) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function normalizePurchasedAt(raw: unknown): string | null {
  const text = normalizeText(raw);
  return text && /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

function normalizeCurrency(raw: unknown): string | null {
  const text = normalizeText(raw);
  if (!text) return null;
  const upper = text.toUpperCase();
  return /^[A-Z]{3}$/.test(upper) ? upper : null;
}

function normalizeConfidence(raw: unknown): number | null {
  const n = normalizeAmount(raw);
  if (n === null || n < 0 || n > 1) return null;
  return n;
}

// Resolves a category name the model returned against the user's own vocabulary,
// independently for the receipt and for every item (spec section 7): a name that is not
// in the list, or a confidence below the floor, leaves the row uncategorised rather than
// guessed at. Never throws: an unknown or low-confidence category drops only the
// category, never the row it was read from.
function pickCategoryMatch(
  nameRaw: unknown,
  confidenceRaw: unknown,
  categories: { id: string; name: string }[],
): { categoryId: string | null; confidence: number | null } {
  const name = normalizeText(nameRaw);
  const confidence = normalizeConfidence(confidenceRaw);
  if (!name || confidence === null || confidence < CATEGORY_CONFIDENCE_THRESHOLD) {
    return { categoryId: null, confidence: null };
  }
  const match = categories.find((c) => c.name.toLowerCase() === name.toLowerCase());
  return match ? { categoryId: match.id, confidence } : { categoryId: null, confidence: null };
}

export type NormalizedReceiptItem = {
  description: string;
  quantity: number | null;
  unitPrice: number | null;
  amount: number;
  categoryId: string | null;
  categorySource: "auto" | null;
  confidence: number | null;
};

function normalizeReceiptItemRow(raw: unknown, categories: { id: string; name: string }[]): NormalizedReceiptItem | null {
  if (typeof raw !== "object" || raw === null) return null;
  const row = raw as Record<string, unknown>;
  const description = normalizeText(row.description);
  if (!description) return null;
  const amount = normalizeAmount(row.amount);
  if (amount === null) return null;
  const { categoryId, confidence } = pickCategoryMatch(row.category, row.categoryConfidence, categories);
  return {
    description: description.slice(0, ITEM_DESCRIPTION_LIMIT),
    quantity: normalizeAmount(row.quantity),
    unitPrice: normalizeAmount(row.unitPrice),
    amount,
    categoryId,
    categorySource: categoryId ? "auto" : null,
    confidence,
  };
}

// Drops only the offending row, the same discipline as fields.models.ts's
// normalizeFieldRows: a bare string, a null, or a row missing its amount is skipped
// rather than failing the whole receipt.
export function normalizeReceiptItemRows(rows: unknown, categories: { id: string; name: string }[]): { items: NormalizedReceiptItem[]; droppedCount: number } {
  if (!Array.isArray(rows)) return { items: [], droppedCount: 0 };
  const items: NormalizedReceiptItem[] = [];
  let droppedCount = 0;
  for (const raw of rows) {
    const normalized = normalizeReceiptItemRow(raw, categories);
    if (normalized) items.push(normalized);
    else droppedCount += 1;
  }
  return { items, droppedCount };
}

export function sumItemAmounts(items: { amount: number }[]): number {
  return roundMoney(items.reduce((sum, item) => sum + item.amount, 0));
}

export function itemsReconcileWithTotal(itemsTotal: number, total: number): boolean {
  return Math.abs(itemsTotal - total) <= RECONCILE_TOLERANCE;
}

export type NormalizedReceiptReply =
  | { failed: true; note: string }
  | {
      failed: false;
      merchant: string | null;
      purchasedAt: string | null;
      currency: string | null;
      total: number | null;
      taxAmount: number | null;
      categoryId: string | null;
      items: NormalizedReceiptItem[];
      status: "ready" | "needs_review";
      note: string | null;
    };

// The one place a raw, loosely-typed reply becomes data DocMind trusts. Every rule from
// spec section 4 lives here, pure and unit-testable without a network call:
// - all four header fields null is a failed read, never a receipt with a blank total.
// - a non-empty warning forces needs_review and lands in the note.
// - items that do not reconcile with the printed total (outside RECONCILE_TOLERANCE)
//   force needs_review too; neither number is ever adjusted to fit the other.
export function normalizeReceiptReply({
  reply,
  categories,
}: {
  reply: { merchant?: unknown; purchasedAt?: unknown; currency?: unknown; total?: unknown; taxAmount?: unknown; category?: unknown; categoryConfidence?: unknown; warning?: unknown; items?: unknown };
  categories: { id: string; name: string }[];
}): NormalizedReceiptReply {
  const merchant = normalizeText(reply.merchant);
  const purchasedAt = normalizePurchasedAt(reply.purchasedAt);
  const currency = normalizeCurrency(reply.currency);
  const total = normalizeAmount(reply.total);
  const warning = normalizeText(reply.warning);

  if (merchant === null && purchasedAt === null && currency === null && total === null) {
    return { failed: true, note: warning ?? "The model could not read a receipt from these photos." };
  }

  const taxAmount = normalizeAmount(reply.taxAmount);
  const { categoryId } = pickCategoryMatch(reply.category, reply.categoryConfidence, categories);
  const { items } = normalizeReceiptItemRows(reply.items, categories);

  const reasons: string[] = [];
  if (warning) reasons.push(warning);
  if (total !== null && items.length > 0) {
    const itemsTotal = sumItemAmounts(items);
    if (!itemsReconcileWithTotal(itemsTotal, total)) {
      reasons.push(`Items total ${itemsTotal.toFixed(2)} does not match the printed total ${total.toFixed(2)}.`);
    }
  }

  return {
    failed: false,
    merchant,
    purchasedAt,
    currency,
    total,
    taxAmount,
    categoryId,
    items,
    status: reasons.length > 0 ? "needs_review" : "ready",
    note: reasons.length > 0 ? reasons.join(" ") : null,
  };
}

function formatCategoryLine(category: { name: string; description: string }): string {
  return `- ${category.name}: ${category.description}`;
}

// The document's photos are the only input to this call (there is no separate "input"
// text field the way generateStructured has one), so the whole instruction set,
// including the category vocabulary, is assembled into the system prompt here.
export function assembleReceiptPrompt({ categories }: { categories: { name: string; description: string }[] }): { system: string } {
  const categoriesBlock = categories.length > 0 ? categories.map(formatCategoryLine).join("\n") : "(none)";
  const system = `You read a receipt for DocMind, a personal budget tracker. You are given every photo of
one physical receipt, in the order they were taken. A long receipt often spans more than
one photo, and shots frequently overlap by a line or two: read them as one continuous
receipt and count every line exactly once, even when it appears on two photos.

Read only what the receipt states, never invent a value it does not show:
- merchant: the shop or business name as printed.
- purchasedAt: the purchase date, as YYYY-MM-DD.
- currency: the ISO 4217 code the prices are in, for example USD or EUR.
- total: the printed total, the amount actually paid.
- taxAmount: VAT, GST, or sales tax, only when the receipt states it separately from the
  total.
- items: every line on the receipt, in printed order. Each needs a description and its own
  amount; give a quantity or a unit price only when the receipt states one.

Categorise the receipt as a whole, and separately categorise every line, using only the
category names listed below. Give a confidence from 0 to 1 for each category you choose.
When nothing on the list fits well, leave that category out rather than guessing.

Categories:
${categoriesBlock}

If the photos clearly do not belong to the same receipt, for example two different shops or
two unrelated purchases, do not merge them into one answer: leave items empty and say why in
"warning".

Reply with JSON only, matching the schema you were given.`;
  return { system };
}
