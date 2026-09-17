import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import * as schema from "./schema.js";

export async function createDatabase({ url }: { url: string }) {
  // The file-mode client pools up to 20 real connections by default. PRAGMA foreign_keys
  // is per connection, so a pool with more than one open connection cannot guarantee the
  // PRAGMA below applies everywhere. The rest of the codebase also assumes a single
  // connection (job runner, transaction helpers), so force exactly one here.
  const client = createClient({ url, concurrency: 1 });
  // Set explicitly rather than relying on the driver's default, since that default is not
  // guaranteed across driver versions.
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
