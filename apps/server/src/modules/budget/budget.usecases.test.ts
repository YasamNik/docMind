import { beforeEach, describe, expect, it } from "vitest";
import { createTestDatabase } from "../../shared/test/database.test-utils.js";
import type { Database } from "../database/database.js";
import { createSettingsRegistry } from "../settings/settings.registry.js";
import { createSettingsService } from "../settings/settings.usecases.js";
import { budgetSettingDefinitions } from "./budget.settings.js";
import { BUDGET_CATEGORY_PRESETS } from "./budget.models.js";
import { createBudgetRepository } from "./budget.repository.js";
import { createBudgetService } from "./budget.usecases.js";

const userId = "user-1";
let db: Database;
let budget: ReturnType<typeof createBudgetService>;
let repository: ReturnType<typeof createBudgetRepository>;

function createTestBudgetService({ db }: { db: Database }) {
  const settingsService = createSettingsService({
    db,
    registry: createSettingsRegistry(budgetSettingDefinitions),
    config: { settingsEncryptionKey: "99".repeat(32), env: {} },
  });
  return createBudgetService({ db, settingsService });
}

beforeEach(async () => {
  ({ db } = await createTestDatabase());
  budget = createTestBudgetService({ db });
  repository = createBudgetRepository({ db });
});

describe("budget service, preset categories", () => {
  it("seeds the preset categories once", async () => {
    await budget.ensureCategoriesSeeded({ userId });
    await budget.ensureCategoriesSeeded({ userId });
    const categories = await repository.listCategoriesRaw(userId);
    expect(categories).toHaveLength(BUDGET_CATEGORY_PRESETS.length);
    expect(categories.map((c) => c.name)).toContain("Groceries");
  });

  it("does not resurrect a preset the user deleted", async () => {
    await budget.ensureCategoriesSeeded({ userId });
    const groceries = (await repository.listCategoriesRaw(userId)).find((c) => c.name === "Groceries")!;
    await repository.deleteCategory({ userId, categoryId: groceries.id });
    await budget.ensureCategoriesSeeded({ userId });
    expect((await repository.listCategoriesRaw(userId)).map((c) => c.name)).not.toContain("Groceries");
  });

  it("keeps the user's own category when a preset wants the same name", async () => {
    const t = new Date().toISOString();
    await repository.insertCategory({
      id: "bcat_custom0000000",
      userId,
      name: "Groceries",
      description: "Mine",
      color: null,
      autoApply: 1,
      createdAt: t,
      updatedAt: t,
    });
    await budget.ensureCategoriesSeeded({ userId });
    const groceries = (await repository.listCategoriesRaw(userId)).filter((c) => c.name.toLowerCase() === "groceries");
    expect(groceries).toHaveLength(1);
    expect(groceries[0]!.description).toBe("Mine");
  });

  it("does not seed a second user's categories into the first user's list", async () => {
    await budget.ensureCategoriesSeeded({ userId });
    await budget.ensureCategoriesSeeded({ userId: "user-2" });
    expect(await repository.listCategoriesRaw(userId)).toHaveLength(BUDGET_CATEGORY_PRESETS.length);
    expect(await repository.listCategoriesRaw("user-2")).toHaveLength(BUDGET_CATEGORY_PRESETS.length);
  });
});
