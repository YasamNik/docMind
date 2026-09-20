import { LibsqlError } from "@libsql/client";
import { createLogger, type Logger } from "../../shared/logger/logger.js";
import type { Database } from "../database/database.js";
import type { SettingsService } from "../settings/settings.usecases.js";
import { BUDGET_CATEGORY_PRESETS, newBudgetCategoryId, nowIso } from "./budget.models.js";
import { createBudgetRepository } from "./budget.repository.js";
import type { NewBudgetCategory } from "./budget.types.js";

function isUniqueConstraintError(error: unknown): boolean {
  const cause = (error as { cause?: unknown } | null)?.cause;
  return cause instanceof LibsqlError && cause.code === "SQLITE_CONSTRAINT";
}

export function createBudgetService({
  db,
  settingsService,
  logger = createLogger("budget"),
}: {
  db: Database;
  settingsService: Pick<SettingsService, "get" | "setInternal">;
  logger?: Logger;
}) {
  const repository = createBudgetRepository({ db });

  function buildPresetCategory(userId: string, preset: { name: string; description: string }): NewBudgetCategory {
    const t = nowIso();
    return {
      id: newBudgetCategoryId(),
      userId,
      name: preset.name,
      description: preset.description,
      color: null,
      autoApply: 1,
      createdAt: t,
      updatedAt: t,
    };
  }

  // Not called at server start, same reasoning as tags.usecases.ts's ensureTypesSeeded: a
  // fresh install has no user at boot. Callers pass a real userId, and the intended call
  // site is the receipt job handler, right before the categorisation prompt is built.
  async function ensureCategoriesSeeded({ userId }: { userId: string }) {
    const done = await settingsService.get<boolean>(userId, "budget.categoriesSeeded");
    if (done) return;

    // Inserted one at a time, not as a batch, so a crash partway through leaves a retry
    // able to finish: the guard flag cannot commit in the same transaction as these rows
    // because the settings repository takes no tx. A name the user already owns is
    // skipped, never overwritten.
    for (const preset of BUDGET_CATEGORY_PRESETS) {
      try {
        await repository.insertCategory(buildPresetCategory(userId, preset));
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          logger.info({ userId, name: preset.name }, "Preset budget category skipped, the name is already taken");
          continue;
        }
        throw error;
      }
    }

    await settingsService.setInternal(userId, "budget.categoriesSeeded", true);
  }

  return {
    ensureCategoriesSeeded,
  };
}

export type BudgetService = ReturnType<typeof createBudgetService>;
