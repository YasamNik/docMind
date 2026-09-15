import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import * as schema from "./schema.js";

export function createDatabase({ url }: { url: string }) {
  const client = createClient({ url });
  const db = drizzle(client, { schema });
  return { db, client };
}

export type Database = ReturnType<typeof createDatabase>["db"];
