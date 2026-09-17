import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import * as schema from "./schema.js";

export async function createDatabase({ url }: { url: string }) {
  const client = createClient({ url });
  // SQLite defaults to foreign_keys=off per connection; the document_tags table relies
  // on ON DELETE CASCADE, so this must be turned on explicitly for every connection.
  await client.execute("PRAGMA foreign_keys = ON");
  const db = drizzle(client, { schema });
  return { db, client };
}

export type Database = Awaited<ReturnType<typeof createDatabase>>["db"];

// Drizzle's transaction callback types the tx object as a distinct transaction type,
// but it is structurally the same as Database for our query usage. This helper centralizes
// the cast so call sites do not repeat `tx as unknown as Database`.
export function asTxDb(tx: unknown): Database {
  return tx as Database;
}
