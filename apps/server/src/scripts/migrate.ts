import { createDatabase } from "../modules/database/database.js";
import { runMigrations } from "../modules/database/database.usecases.js";

const { db } = createDatabase({ url: process.env.DATABASE_URL ?? "file:./docmind.sqlite" });
await runMigrations({ db });
console.log("Migrations applied");
