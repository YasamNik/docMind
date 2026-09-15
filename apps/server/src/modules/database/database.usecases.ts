import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { migrate } from "drizzle-orm/libsql/migrator";
import type { Database } from "./database.js";

const here = dirname(fileURLToPath(import.meta.url));
// src/modules/database -> apps/server/drizzle. The same relative path works from dist/.
export const migrationsFolder = resolve(here, "../../../drizzle");

export async function runMigrations({ db }: { db: Database }) {
  await migrate(db, { migrationsFolder });
}
