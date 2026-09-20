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
