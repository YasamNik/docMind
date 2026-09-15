import { createDatabase } from "../../modules/database/database.js";
import { runMigrations } from "../../modules/database/database.usecases.js";

export async function createTestDatabase() {
  const { db } = createDatabase({ url: ":memory:" });
  await runMigrations({ db });
  return { db };
}
