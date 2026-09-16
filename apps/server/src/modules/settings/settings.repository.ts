import { and, eq } from "drizzle-orm";
import type { Database } from "../database/database.js";
import { settingsTable } from "./settings.tables.js";

export function createSettingsRepository({ db }: { db: Database }) {
  return {
    async listForUser(userId: string) {
      return db.select().from(settingsTable).where(eq(settingsTable.userId, userId));
    },
    async upsert({ userId, key, value, isSecret }: { userId: string; key: string; value: string; isSecret: boolean }) {
      const updatedAt = new Date().toISOString();
      await db
        .insert(settingsTable)
        .values({ userId, key, value, isSecret: isSecret ? 1 : 0, updatedAt })
        .onConflictDoUpdate({
          target: [settingsTable.userId, settingsTable.key],
          set: { value, isSecret: isSecret ? 1 : 0, updatedAt },
        });
    },
    async remove({ userId, key }: { userId: string; key: string }) {
      await db.delete(settingsTable).where(and(eq(settingsTable.userId, userId), eq(settingsTable.key, key)));
    },
  };
}

export type SettingsRepository = ReturnType<typeof createSettingsRepository>;
