import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const settingsTable = sqliteTable(
  "settings",
  {
    userId: text("user_id").notNull(),
    key: text("key").notNull(),
    value: text("value").notNull(),
    isSecret: integer("is_secret").notNull().default(0),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.key] })],
);
