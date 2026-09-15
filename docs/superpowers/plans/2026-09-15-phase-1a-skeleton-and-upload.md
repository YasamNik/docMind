# Phase 1, Milestone A: Skeleton and Upload Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A running DocMind with sign in, encrypted settings, a local storage driver, streamed upload with duplicate detection, and a library page with preview, so the user has a private place to put files.

**Architecture:** pnpm workspace with `apps/server` (Hono on Node 22, Drizzle on libsql, valibot everywhere) and `apps/client` (React, Vite, Tailwind, shadcn/ui). Server modules are self-contained directories with files named by role. Settings, storage, auth, and documents are the four modules built here; extraction, jobs, AI, and rules come in later milestones.

**Tech Stack:** Node 22, pnpm, TypeScript, Hono, @hono/node-server, drizzle-orm, @libsql/client, drizzle-kit, valibot, better-auth with @better-auth/drizzle-adapter, pino, vitest, tsx. Client: React 18, Vite, react-router-dom, @tanstack/react-query, Tailwind, shadcn/ui, better-auth/react.

**Spec:** `docs/superpowers/specs/2026-09-15-phase-1-smart-sorting-design.md` (Milestone A) and `DOCMIND-DESIGN.md` (Settings Module, Storage Layer, Data Model).

## Global Constraints

- Node 22 via nvm (`nvm use 22`), pnpm via `corepack enable`. Bun is not used.
- Every HTTP input, env value, and setting is parsed with valibot before use.
- All database access through Drizzle. Raw SQL only in migrations.
- File bodies are streams end to end. Never read a whole upload into memory.
- Secrets are encrypted at rest with AES-256-GCM under `SETTINGS_ENCRYPTION_KEY`, never logged, never returned by the API.
- Settings resolution order: database, then env var, then default.
- Local storage keys are `userId/documentId/filename` and must resolve inside the root.
- Timestamps are ISO 8601 strings in UTC.
- Module files are named by role: `*.routes.ts`, `*.usecases.ts`, `*.models.ts`, `*.repository.ts`, `*.tables.ts`, `*.schemas.ts`, `*.settings.ts`, `*.types.ts`. Tests sit next to the file as `*.test.ts`.
- No em dashes anywhere: code, comments, copy, commit messages.
- `ref_code/` is reference only. Never copy from it, never import it.
- Conventional commits with the attribution trailer from the harness.
- Run tests with `pnpm --filter @docmind/server test` from the repo root, or `pnpm test` inside `apps/server`.

## Conventions used in every task

- `apps/server/src/shared/test/database.test-utils.ts` (Task 3) gives `createTestDatabase()` returning `{ db }` on in-memory SQLite with all migrations applied.
- `apps/server/src/shared/test/app.test-utils.ts` (Task 9) gives `createTestApp()` returning `{ app, db, signIn }` for route tests.
- Errors thrown from usecases are `AppError` (Task 2) with `code`, `status`, `message`. Routes map them to JSON `{ error: { code, message } }`.

---

### Task 1: Workspace and server skeleton

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `.npmrc`, `.nvmrc`, `tsconfig.base.json`
- Create: `apps/server/package.json`, `apps/server/tsconfig.json`, `apps/server/vitest.config.ts`
- Create: `apps/server/src/app.ts`, `apps/server/src/index.ts`
- Test: `apps/server/src/app.test.ts`

**Interfaces:**
- Produces: `createApp(): Hono` in `app.ts`, exporting a Hono app with `GET /api/health` returning `{ status: "ok" }`.

- [ ] **Step 1: Create the workspace files**

`package.json` (root):
```json
{
  "name": "docmind",
  "private": true,
  "packageManager": "pnpm@10.12.1",
  "scripts": {
    "dev": "pnpm -r --parallel run dev",
    "build": "pnpm -r run build",
    "test": "pnpm -r run test",
    "typecheck": "pnpm -r run typecheck"
  }
}
```

`pnpm-workspace.yaml`:
```yaml
packages:
  - "apps/*"
```

`.npmrc`:
```
auto-install-peers=true
```

`.nvmrc`:
```
22
```

`tsconfig.base.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noUncheckedIndexedAccess": true
  }
}
```

`apps/server/package.json`:
```json
{
  "name": "@docmind/server",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch --env-file=.env src/index.ts",
    "start": "node --env-file=.env dist/index.js",
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc --noEmit -p tsconfig.json",
    "test": "vitest run",
    "test:watch": "vitest",
    "db:generate": "drizzle-kit generate",
    "db:migrate": "tsx src/scripts/migrate.ts"
  },
  "dependencies": {
    "@hono/node-server": "^1.14.0",
    "hono": "^4.7.0",
    "pino": "^9.6.0",
    "valibot": "^1.1.0"
  },
  "devDependencies": {
    "@types/node": "^22.15.0",
    "tsx": "^4.19.0",
    "typescript": "^5.8.0",
    "vitest": "^3.1.0"
  }
}
```

`apps/server/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src",
    "types": ["node"]
  },
  "include": ["src"],
  "exclude": ["src/**/*.test.ts"]
}
```

`apps/server/vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    clearMocks: true,
  },
});
```

- [ ] **Step 2: Write the failing test**

`apps/server/src/app.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";

describe("app", () => {
  it("answers the health check", async () => {
    const app = createApp();
    const res = await app.request("/api/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });
});
```

- [ ] **Step 3: Install and run the test to see it fail**

Run from repo root:
```bash
nvm use 22 && corepack enable && pnpm install && pnpm --filter @docmind/server test
```
Expected: FAIL, cannot find module `./app.js`.

- [ ] **Step 4: Write the app and entry point**

`apps/server/src/app.ts`:
```ts
import { Hono } from "hono";

export function createApp() {
  const app = new Hono();
  app.get("/api/health", (c) => c.json({ status: "ok" }));
  return app;
}
```

`apps/server/src/index.ts`:
```ts
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";

const app = createApp();
const port = Number(process.env.PORT ?? 4000);

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`DocMind server listening on http://localhost:${info.port}`);
});
```

- [ ] **Step 5: Run the test to see it pass**

Run: `pnpm --filter @docmind/server test`
Expected: PASS, 1 test.

- [ ] **Step 6: Commit**

```bash
git add package.json pnpm-workspace.yaml .npmrc .nvmrc tsconfig.base.json pnpm-lock.yaml apps/server
git commit -m "feat(server): scaffold pnpm workspace and Hono server with health check"
```

---

### Task 2: Config module and shared errors

**Files:**
- Create: `apps/server/src/modules/config/config.schemas.ts`, `apps/server/src/modules/config/config.ts`
- Create: `apps/server/src/shared/errors/errors.ts`
- Create: `apps/server/src/shared/logger/logger.ts`
- Create: `apps/server/.env.example`
- Test: `apps/server/src/modules/config/config.test.ts`

**Interfaces:**
- Produces: `parseConfig(env: Record<string, string | undefined>): Config` and the `Config` type with `port`, `serverBaseUrl`, `clientBaseUrl`, `authSecret`, `databaseUrl`, `settingsEncryptionKey`, and `env` (the raw env, which the settings module uses for seeds such as `DOCUMENT_STORAGE_ROOT`).
- Produces: `class AppError extends Error { code: string; status: number }` and `createError({ code, message, status })`.
- Produces: `createLogger(namespace: string)` returning a pino child logger.

- [ ] **Step 1: Write the failing test**

`apps/server/src/modules/config/config.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { parseConfig } from "./config.js";

const valid = {
  SETTINGS_ENCRYPTION_KEY: "a".repeat(64),
  AUTH_SECRET: "b".repeat(32),
};

describe("parseConfig", () => {
  it("applies defaults for optional values", () => {
    const config = parseConfig(valid);
    expect(config.port).toBe(4000);
    expect(config.databaseUrl).toBe("file:./docmind.sqlite");
    expect(config.serverBaseUrl).toBe("http://localhost:4000");
  });

  it("refuses to start without the encryption key and names the command", () => {
    expect(() => parseConfig({ AUTH_SECRET: valid.AUTH_SECRET })).toThrow(
      /SETTINGS_ENCRYPTION_KEY.*openssl rand -hex 32/s,
    );
  });

  it("rejects an encryption key that is not 32 bytes of hex", () => {
    expect(() => parseConfig({ ...valid, SETTINGS_ENCRYPTION_KEY: "abc" })).toThrow(
      /SETTINGS_ENCRYPTION_KEY/,
    );
  });

  it("parses PORT as a number", () => {
    expect(parseConfig({ ...valid, PORT: "5050" }).port).toBe(5050);
  });
});
```

- [ ] **Step 2: Run the test to see it fail**

Run: `pnpm --filter @docmind/server test -- config`
Expected: FAIL, cannot find module `./config.js`.

- [ ] **Step 3: Write errors, logger, schemas, and config**

`apps/server/src/shared/errors/errors.ts`:
```ts
export class AppError extends Error {
  code: string;
  status: number;

  constructor({ code, message, status }: { code: string; message: string; status: number }) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = status;
  }
}

export function createError(args: { code: string; message: string; status?: number }) {
  return new AppError({ status: 500, ...args });
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}
```

`apps/server/src/shared/logger/logger.ts`:
```ts
import pino from "pino";

const root = pino({
  level: process.env.LOG_LEVEL ?? "info",
  redact: ["*.apiKey", "*.secret", "*.password", "*.token", "*.authorization"],
});

export function createLogger(namespace: string) {
  return root.child({ namespace });
}

export type Logger = ReturnType<typeof createLogger>;
```

`apps/server/src/modules/config/config.schemas.ts`:
```ts
import * as v from "valibot";

export const hexKeySchema = (bytes: number, name: string) =>
  v.pipe(
    v.string(`${name} is required. Generate one with: openssl rand -hex ${bytes}`),
    v.regex(
      new RegExp(`^[0-9a-fA-F]{${bytes * 2}}$`),
      `${name} must be ${bytes} bytes of hex. Generate one with: openssl rand -hex ${bytes}`,
    ),
  );

export const portSchema = v.pipe(
  v.optional(v.string(), "4000"),
  v.transform(Number),
  v.integer(),
  v.minValue(1),
  v.maxValue(65535),
);

export const urlSchema = v.pipe(v.string(), v.url());
```

`apps/server/src/modules/config/config.ts`:
```ts
import * as v from "valibot";
import { hexKeySchema, portSchema, urlSchema } from "./config.schemas.js";

const envSchema = v.object({
  PORT: portSchema,
  SERVER_BASE_URL: v.optional(urlSchema, "http://localhost:4000"),
  CLIENT_BASE_URL: v.optional(urlSchema, "http://localhost:5173"),
  AUTH_SECRET: v.pipe(v.string("AUTH_SECRET is required. Generate one with: openssl rand -hex 48"), v.minLength(32)),
  DATABASE_URL: v.optional(v.string(), "file:./docmind.sqlite"),
  SETTINGS_ENCRYPTION_KEY: hexKeySchema(32, "SETTINGS_ENCRYPTION_KEY"),
});

export type Config = {
  port: number;
  serverBaseUrl: string;
  clientBaseUrl: string;
  authSecret: string;
  databaseUrl: string;
  settingsEncryptionKey: string;
  env: Record<string, string | undefined>;
};

export function parseConfig(env: Record<string, string | undefined>): Config {
  const result = v.safeParse(envSchema, env);
  if (!result.success) {
    const lines = result.issues.map((issue) => {
      const key = issue.path?.map((p) => String(p.key)).join(".") ?? "env";
      return `${key}: ${issue.message}`;
    });
    throw new Error(`Invalid configuration:\n${lines.join("\n")}`);
  }
  const e = result.output;
  return {
    port: e.PORT,
    serverBaseUrl: e.SERVER_BASE_URL,
    clientBaseUrl: e.CLIENT_BASE_URL,
    authSecret: e.AUTH_SECRET,
    databaseUrl: e.DATABASE_URL,
    settingsEncryptionKey: e.SETTINGS_ENCRYPTION_KEY,
    env,
  };
}

export function loadConfig(): Config {
  return parseConfig(process.env);
}
```

`apps/server/.env.example`:
```bash
# Required. Generate with: openssl rand -hex 32
SETTINGS_ENCRYPTION_KEY=

# Required. Generate with: openssl rand -hex 48
AUTH_SECRET=

PORT=4000
SERVER_BASE_URL=http://localhost:4000
CLIENT_BASE_URL=http://localhost:5173
DATABASE_URL=file:./docmind.sqlite
DOCUMENT_STORAGE_ROOT=./documents

# Optional seeds. The settings UI overrides these.
OPENROUTER_API_KEY=
AI_RULES_MODEL=
AI_CHAT_MODEL=
AI_EMBEDDING_MODEL=
```

- [ ] **Step 4: Run the test to see it pass**

Run: `pnpm --filter @docmind/server test -- config`
Expected: PASS, 4 tests. If the PORT test fails because `v.integer()` rejects the transformed value, check that `v.transform(Number)` precedes it in the pipe.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/modules/config apps/server/src/shared apps/server/.env.example
git commit -m "feat(server): add validated config, app errors, and logger"
```

---

### Task 3: Database module with migrations and test helper

**Files:**
- Create: `apps/server/src/modules/database/database.ts`, `apps/server/src/modules/database/database.usecases.ts`, `apps/server/src/modules/database/schema.ts`
- Create: `apps/server/drizzle.config.ts`, `apps/server/src/scripts/migrate.ts`
- Create: `apps/server/src/shared/test/database.test-utils.ts`
- Test: `apps/server/src/modules/database/database.test.ts`

**Interfaces:**
- Produces: `createDatabase({ url }): { db: Database; client: Client }` and `type Database`.
- Produces: `runMigrations({ db })`.
- Produces: `createTestDatabase(): Promise<{ db: Database }>` on `:memory:` with migrations applied.
- Produces: `schema.ts` re-exporting every module's `*.tables.ts`. Later tasks add their tables there.

- [ ] **Step 1: Add dependencies**

```bash
pnpm --filter @docmind/server add drizzle-orm @libsql/client
pnpm --filter @docmind/server add -D drizzle-kit
```

- [ ] **Step 2: Write the failing test**

`apps/server/src/modules/database/database.test.ts`:
```ts
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createTestDatabase } from "../../shared/test/database.test-utils.js";

describe("database", () => {
  it("applies migrations to an in-memory database", async () => {
    const { db } = await createTestDatabase();
    const rows = await db.all<{ name: string }>(
      sql`select name from sqlite_master where type = 'table' and name = '__drizzle_migrations'`,
    );
    expect(rows.length).toBe(1);
  });
});
```

- [ ] **Step 3: Run the test to see it fail**

Run: `pnpm --filter @docmind/server test -- database`
Expected: FAIL, cannot find module.

- [ ] **Step 4: Write the database module**

`apps/server/src/modules/database/schema.ts`:
```ts
// Every module's tables are re-exported here so drizzle-kit and the migrator see them.
export {};
```

`apps/server/src/modules/database/database.ts`:
```ts
import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import * as schema from "./schema.js";

export function createDatabase({ url }: { url: string }) {
  const client = createClient({ url });
  const db = drizzle(client, { schema });
  return { db, client };
}

export type Database = ReturnType<typeof createDatabase>["db"];
```

`apps/server/src/modules/database/database.usecases.ts`:
```ts
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
```

`apps/server/drizzle.config.ts`:
```ts
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/modules/database/schema.ts",
  out: "./drizzle",
  dbCredentials: { url: process.env.DATABASE_URL ?? "file:./docmind.sqlite" },
});
```

`apps/server/src/scripts/migrate.ts`:
```ts
import { createDatabase } from "../modules/database/database.js";
import { runMigrations } from "../modules/database/database.usecases.js";

const { db } = createDatabase({ url: process.env.DATABASE_URL ?? "file:./docmind.sqlite" });
await runMigrations({ db });
console.log("Migrations applied");
```

`apps/server/src/shared/test/database.test-utils.ts`:
```ts
import { createDatabase } from "../../modules/database/database.js";
import { runMigrations } from "../../modules/database/database.usecases.js";

export async function createTestDatabase() {
  const { db } = createDatabase({ url: ":memory:" });
  await runMigrations({ db });
  return { db };
}
```

- [ ] **Step 5: Generate the first (empty) migration and run the test**

```bash
cd apps/server && pnpm db:generate --name init && cd ../..
pnpm --filter @docmind/server test -- database
```
If drizzle-kit refuses to generate with an empty schema, create `drizzle/0000_init.sql` by hand containing a single comment line `-- init` and `drizzle/meta/_journal.json` with `{"version":"7","dialect":"sqlite","entries":[]}`. Later tasks regenerate properly once tables exist.
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/server
git commit -m "feat(server): add drizzle database module, migrations, and test helper"
```

---

### Task 4: Settings encryption

**Files:**
- Create: `apps/server/src/modules/settings/settings.crypto.ts`
- Test: `apps/server/src/modules/settings/settings.crypto.test.ts`

**Interfaces:**
- Produces: `encryptSecret({ plaintext, keyHex }): string` returning `enc:v1:<iv b64>:<tag b64>:<ciphertext b64>`, and `decryptSecret({ ciphertext, keyHex }): string`. Both throw `AppError` with code `settings.bad_ciphertext` on a malformed or tampered value.

- [ ] **Step 1: Write the failing test**

`apps/server/src/modules/settings/settings.crypto.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret } from "./settings.crypto.js";

const keyHex = "0f".repeat(32);

describe("settings crypto", () => {
  it("round trips a secret", () => {
    const ciphertext = encryptSecret({ plaintext: "sk-or-v1-abc", keyHex });
    expect(ciphertext.startsWith("enc:v1:")).toBe(true);
    expect(ciphertext).not.toContain("sk-or-v1-abc");
    expect(decryptSecret({ ciphertext, keyHex })).toBe("sk-or-v1-abc");
  });

  it("produces a different ciphertext each time", () => {
    const a = encryptSecret({ plaintext: "same", keyHex });
    const b = encryptSecret({ plaintext: "same", keyHex });
    expect(a).not.toBe(b);
  });

  it("rejects tampered ciphertext", () => {
    const ciphertext = encryptSecret({ plaintext: "secret", keyHex });
    const parts = ciphertext.split(":");
    parts[4] = Buffer.from("xxxx").toString("base64");
    expect(() => decryptSecret({ ciphertext: parts.join(":"), keyHex })).toThrow(/bad_ciphertext/);
  });

  it("rejects a value that is not in the enc:v1 format", () => {
    expect(() => decryptSecret({ ciphertext: "plain", keyHex })).toThrow(/bad_ciphertext/);
  });
});
```

- [ ] **Step 2: Run the test to see it fail**

Run: `pnpm --filter @docmind/server test -- settings.crypto`
Expected: FAIL, cannot find module.

- [ ] **Step 3: Write the implementation**

`apps/server/src/modules/settings/settings.crypto.ts`:
```ts
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { createError } from "../../shared/errors/errors.js";

const PREFIX = "enc:v1";

function badCiphertext() {
  return createError({
    code: "settings.bad_ciphertext",
    message: "Stored secret could not be decrypted. Was SETTINGS_ENCRYPTION_KEY changed?",
    status: 500,
  });
}

export function encryptSecret({ plaintext, keyHex }: { plaintext: string; keyHex: string }) {
  const key = Buffer.from(keyHex, "hex");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [PREFIX, iv.toString("base64"), tag.toString("base64"), ciphertext.toString("base64")].join(":");
}

export function decryptSecret({ ciphertext, keyHex }: { ciphertext: string; keyHex: string }) {
  const parts = ciphertext.split(":");
  if (parts.length !== 5 || `${parts[0]}:${parts[1]}` !== PREFIX) throw badCiphertext();
  try {
    const key = Buffer.from(keyHex, "hex");
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(parts[2]!, "base64"));
    decipher.setAuthTag(Buffer.from(parts[3]!, "base64"));
    const plaintext = Buffer.concat([decipher.update(Buffer.from(parts[4]!, "base64")), decipher.final()]);
    return plaintext.toString("utf8");
  } catch {
    throw badCiphertext();
  }
}

export function isEncrypted(value: string) {
  return value.startsWith(`${PREFIX}:`);
}
```

- [ ] **Step 4: Run the test to see it pass**

Run: `pnpm --filter @docmind/server test -- settings.crypto`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/modules/settings
git commit -m "feat(settings): add AES-256-GCM secret encryption"
```

---

### Task 5: Settings registry, table, and resolution

**Files:**
- Create: `apps/server/src/modules/settings/settings.types.ts`, `settings.registry.ts`, `settings.tables.ts`, `settings.repository.ts`, `settings.usecases.ts`
- Modify: `apps/server/src/modules/database/schema.ts`
- Test: `apps/server/src/modules/settings/settings.usecases.test.ts`

**Interfaces:**
- Produces: `defineSetting<T>({ key, schema, env?, default?, secret?, doc })` and `SettingDefinition`.
- Produces: `createSettingsRegistry(definitions: SettingDefinition[])` with `get(key)` and `all()`.
- Produces: `createSettingsService({ db, registry, config })` with:
  - `get<T>(userId, key): Promise<T | undefined>` (plaintext for secrets, server use only)
  - `getResolved(userId, key): Promise<{ key, value, source: "db" | "env" | "default" | "unset", secret, doc }>` (masked for secrets)
  - `listResolved(userId)`
  - `set(userId, updates: Record<string, unknown | null>)` validating each value, encrypting secrets, `null` deleting the row, empty string on a secret deleting the row
  - `invalidate()`
- Table `settings(user_id, key, value, is_secret, updated_at)` with primary key `(user_id, key)`.

- [ ] **Step 1: Write the failing test**

`apps/server/src/modules/settings/settings.usecases.test.ts`:
```ts
import * as v from "valibot";
import { beforeEach, describe, expect, it } from "vitest";
import { createTestDatabase } from "../../shared/test/database.test-utils.js";
import { createSettingsRegistry, defineSetting } from "./settings.registry.js";
import { createSettingsService } from "./settings.usecases.js";

const keyHex = "ab".repeat(32);
const user = "user-1";

const definitions = [
  defineSetting({ key: "test.color", schema: v.string(), env: "TEST_COLOR", default: "blue", doc: "A color" }),
  defineSetting({ key: "test.apiKey", schema: v.string(), env: "TEST_API_KEY", secret: true, doc: "A key" }),
  defineSetting({ key: "test.limit", schema: v.number(), default: 25, doc: "A number" }),
];

function service(env: Record<string, string | undefined> = {}) {
  return createTestDatabase().then(({ db }) =>
    createSettingsService({
      db,
      registry: createSettingsRegistry(definitions),
      config: { settingsEncryptionKey: keyHex, env },
    }),
  );
}

describe("settings service", () => {
  it("resolves default, then env, then db", async () => {
    const s = await service({ TEST_COLOR: "green" });
    expect(await s.getResolved(user, "test.limit")).toMatchObject({ value: 25, source: "default" });
    expect(await s.getResolved(user, "test.color")).toMatchObject({ value: "green", source: "env" });
    await s.set(user, { "test.color": "red" });
    expect(await s.getResolved(user, "test.color")).toMatchObject({ value: "red", source: "db" });
  });

  it("stores secrets encrypted and masks them on read", async () => {
    const s = await service();
    await s.set(user, { "test.apiKey": "sk-or-v1-1234567890" });
    const rows = await s.debugRows(user);
    expect(rows[0]?.value.startsWith("enc:v1:")).toBe(true);
    expect(await s.get(user, "test.apiKey")).toBe("sk-or-v1-1234567890");
    expect(await s.getResolved(user, "test.apiKey")).toMatchObject({
      value: { isSet: true, lastFour: "7890" },
      source: "db",
      secret: true,
    });
  });

  it("reports an unset secret without leaking anything", async () => {
    const s = await service();
    expect(await s.getResolved(user, "test.apiKey")).toMatchObject({ value: { isSet: false }, source: "unset" });
  });

  it("null deletes the row so the value falls back", async () => {
    const s = await service({ TEST_COLOR: "green" });
    await s.set(user, { "test.color": "red" });
    await s.set(user, { "test.color": null });
    expect(await s.getResolved(user, "test.color")).toMatchObject({ value: "green", source: "env" });
  });

  it("empty string on a secret deletes the row", async () => {
    const s = await service();
    await s.set(user, { "test.apiKey": "abc" });
    await s.set(user, { "test.apiKey": "" });
    expect(await s.getResolved(user, "test.apiKey")).toMatchObject({ value: { isSet: false } });
  });

  it("rejects values that fail the schema and unknown keys", async () => {
    const s = await service();
    await expect(s.set(user, { "test.limit": "not a number" })).rejects.toThrow(/settings.invalid_value/);
    await expect(s.set(user, { "nope": 1 })).rejects.toThrow(/settings.unknown_key/);
  });

  it("serves from cache and invalidates on write", async () => {
    const s = await service();
    await s.set(user, { "test.limit": 5 });
    expect(await s.get(user, "test.limit")).toBe(5);
    await s.set(user, { "test.limit": 6 });
    expect(await s.get(user, "test.limit")).toBe(6);
  });
});
```

- [ ] **Step 2: Run the test to see it fail**

Run: `pnpm --filter @docmind/server test -- settings.usecases`
Expected: FAIL, cannot find module.

- [ ] **Step 3: Write types, registry, table, repository, and service**

`apps/server/src/modules/settings/settings.types.ts`:
```ts
import type { GenericSchema } from "valibot";

export type SettingDefinition<T = unknown> = {
  key: string;
  schema: GenericSchema<unknown, T>;
  env?: string;
  default?: T;
  secret: boolean;
  doc: string;
};

export type SettingSource = "db" | "env" | "default" | "unset";

export type MaskedSecret = { isSet: boolean; lastFour?: string };

export type ResolvedSetting = {
  key: string;
  value: unknown;
  source: SettingSource;
  secret: boolean;
  doc: string;
};
```

`apps/server/src/modules/settings/settings.registry.ts`:
```ts
import type { GenericSchema } from "valibot";
import { createError } from "../../shared/errors/errors.js";
import type { SettingDefinition } from "./settings.types.js";

export function defineSetting<T>(args: {
  key: string;
  schema: GenericSchema<unknown, T>;
  env?: string;
  default?: T;
  secret?: boolean;
  doc: string;
}): SettingDefinition<T> {
  return { secret: false, ...args };
}

export function createSettingsRegistry(definitions: SettingDefinition[]) {
  const byKey = new Map(definitions.map((d) => [d.key, d]));
  if (byKey.size !== definitions.length) throw new Error("Duplicate setting key in registry");
  return {
    get(key: string): SettingDefinition {
      const definition = byKey.get(key);
      if (!definition) {
        throw createError({ code: "settings.unknown_key", message: `Unknown setting "${key}"`, status: 400 });
      }
      return definition;
    },
    has(key: string) {
      return byKey.has(key);
    },
    all(): SettingDefinition[] {
      return [...byKey.values()];
    },
  };
}

export type SettingsRegistry = ReturnType<typeof createSettingsRegistry>;
```

`apps/server/src/modules/settings/settings.tables.ts`:
```ts
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
```

Add to `apps/server/src/modules/database/schema.ts` (replace the `export {}` line):
```ts
export * from "../settings/settings.tables.js";
```

`apps/server/src/modules/settings/settings.repository.ts`:
```ts
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
```

`apps/server/src/modules/settings/settings.usecases.ts`:
```ts
import * as v from "valibot";
import type { Database } from "../database/database.js";
import { createError } from "../../shared/errors/errors.js";
import { decryptSecret, encryptSecret } from "./settings.crypto.js";
import { createSettingsRepository } from "./settings.repository.js";
import type { SettingsRegistry } from "./settings.registry.js";
import type { MaskedSecret, ResolvedSetting, SettingDefinition } from "./settings.types.js";

type ServiceConfig = { settingsEncryptionKey: string; env: Record<string, string | undefined> };

function mask(plaintext: string | undefined): MaskedSecret {
  if (!plaintext) return { isSet: false };
  return { isSet: true, lastFour: plaintext.slice(-4) };
}

export function createSettingsService({
  db,
  registry,
  config,
}: {
  db: Database;
  registry: SettingsRegistry;
  config: ServiceConfig;
}) {
  const repository = createSettingsRepository({ db });
  // userId -> key -> raw db value (ciphertext for secrets, JSON otherwise)
  const cache = new Map<string, Map<string, string>>();

  async function rowsFor(userId: string) {
    let rows = cache.get(userId);
    if (!rows) {
      const stored = await repository.listForUser(userId);
      rows = new Map(stored.map((r) => [r.key, r.value]));
      cache.set(userId, rows);
    }
    return rows;
  }

  function parseOrThrow(definition: SettingDefinition, value: unknown) {
    const result = v.safeParse(definition.schema, value);
    if (!result.success) {
      throw createError({
        code: "settings.invalid_value",
        message: `Invalid value for "${definition.key}": ${result.issues[0]?.message ?? "invalid"}`,
        status: 400,
      });
    }
    return result.output;
  }

  async function resolveRaw(userId: string, key: string): Promise<{ value: unknown; source: ResolvedSetting["source"] }> {
    const definition = registry.get(key);
    const rows = await rowsFor(userId);
    const stored = rows.get(key);
    if (stored !== undefined) {
      if (definition.secret) return { value: decryptSecret({ ciphertext: stored, keyHex: config.settingsEncryptionKey }), source: "db" };
      return { value: parseOrThrow(definition, JSON.parse(stored)), source: "db" };
    }
    const fromEnv = definition.env ? config.env[definition.env] : undefined;
    if (fromEnv !== undefined && fromEnv !== "") {
      return { value: definition.secret ? fromEnv : parseOrThrow(definition, coerceEnv(definition, fromEnv)), source: "env" };
    }
    if (definition.default !== undefined) return { value: definition.default, source: "default" };
    return { value: undefined, source: "unset" };
  }

  function coerceEnv(definition: SettingDefinition, raw: string): unknown {
    // Env vars are strings. Try JSON first so numbers and booleans work, fall back to the string.
    try {
      const parsed = JSON.parse(raw);
      return v.safeParse(definition.schema, parsed).success ? parsed : raw;
    } catch {
      return raw;
    }
  }

  return {
    async get<T = unknown>(userId: string, key: string): Promise<T | undefined> {
      return (await resolveRaw(userId, key)).value as T | undefined;
    },

    async getResolved(userId: string, key: string): Promise<ResolvedSetting> {
      const definition = registry.get(key);
      const { value, source } = await resolveRaw(userId, key);
      return {
        key,
        value: definition.secret ? mask(value as string | undefined) : value,
        source,
        secret: definition.secret,
        doc: definition.doc,
      };
    },

    async listResolved(userId: string): Promise<ResolvedSetting[]> {
      return Promise.all(registry.all().map((d) => this.getResolved(userId, d.key)));
    },

    async set(userId: string, updates: Record<string, unknown>) {
      for (const [key, value] of Object.entries(updates)) {
        const definition = registry.get(key);
        const clears = value === null || (definition.secret && value === "");
        if (clears) {
          await repository.remove({ userId, key });
          continue;
        }
        if (definition.secret) {
          if (typeof value !== "string") {
            throw createError({ code: "settings.invalid_value", message: `Secret "${key}" must be a string`, status: 400 });
          }
          await repository.upsert({ userId, key, isSecret: true, value: encryptSecret({ plaintext: value, keyHex: config.settingsEncryptionKey }) });
          continue;
        }
        const parsed = parseOrThrow(definition, value);
        await repository.upsert({ userId, key, isSecret: false, value: JSON.stringify(parsed) });
      }
      cache.delete(userId);
    },

    invalidate() {
      cache.clear();
    },

    // Test helper. Returns raw rows so tests can assert ciphertext without reading the table directly.
    async debugRows(userId: string) {
      return repository.listForUser(userId);
    },
  };
}

export type SettingsService = ReturnType<typeof createSettingsService>;
```

- [ ] **Step 4: Generate the migration and run the test**

```bash
cd apps/server && pnpm db:generate --name settings && cd ../..
pnpm --filter @docmind/server test -- settings
```
Expected: PASS, 7 tests plus the crypto tests.

- [ ] **Step 5: Commit**

```bash
git add apps/server
git commit -m "feat(settings): add registry, table, and db-env-default resolution with encrypted secrets"
```

---

### Task 6: Settings routes

**Files:**
- Create: `apps/server/src/modules/settings/settings.routes.ts`, `apps/server/src/modules/settings/settings.schemas.ts`
- Create: `apps/server/src/shared/http/error-handler.ts`
- Test: `apps/server/src/modules/settings/settings.routes.test.ts`

**Interfaces:**
- Consumes: `SettingsService` from Task 5.
- Produces: `registerSettingsRoutes({ app, settingsService, getUserId })`. Routes: `GET /api/settings` returning `{ settings: ResolvedSetting[] }`, `PUT /api/settings` with body `{ updates: Record<string, unknown> }` returning the same list.
- Produces: `errorHandler` for Hono that maps `AppError` to `{ error: { code, message } }` with its status, and anything else to 500 with code `internal`.
- `getUserId(c)` is a function the caller passes; Task 9 replaces the test stub with the real session. Until then tests pass `() => "user-1"`.

- [ ] **Step 1: Write the failing test**

`apps/server/src/modules/settings/settings.routes.test.ts`:
```ts
import { Hono } from "hono";
import * as v from "valibot";
import { describe, expect, it } from "vitest";
import { errorHandler } from "../../shared/http/error-handler.js";
import { createTestDatabase } from "../../shared/test/database.test-utils.js";
import { createSettingsRegistry, defineSetting } from "./settings.registry.js";
import { registerSettingsRoutes } from "./settings.routes.js";
import { createSettingsService } from "./settings.usecases.js";

async function makeApp() {
  const { db } = await createTestDatabase();
  const registry = createSettingsRegistry([
    defineSetting({ key: "test.color", schema: v.string(), default: "blue", doc: "A color" }),
    defineSetting({ key: "test.apiKey", schema: v.string(), secret: true, doc: "A key" }),
  ]);
  const settingsService = createSettingsService({ db, registry, config: { settingsEncryptionKey: "cd".repeat(32), env: {} } });
  const app = new Hono();
  app.onError(errorHandler);
  registerSettingsRoutes({ app, settingsService, getUserId: () => "user-1" });
  return app;
}

describe("settings routes", () => {
  it("lists settings with masked secrets", async () => {
    const app = await makeApp();
    const res = await app.request("/api/settings");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.settings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "test.color", value: "blue", source: "default" }),
        expect.objectContaining({ key: "test.apiKey", value: { isSet: false }, secret: true }),
      ]),
    );
  });

  it("updates values and never echoes a secret", async () => {
    const app = await makeApp();
    const res = await app.request("/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ updates: { "test.color": "red", "test.apiKey": "sk-1234" } }),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("sk-1234");
    const body = JSON.parse(text);
    expect(body.settings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "test.color", value: "red", source: "db" }),
        expect.objectContaining({ key: "test.apiKey", value: { isSet: true, lastFour: "1234" } }),
      ]),
    );
  });

  it("returns 400 with a code for a bad key", async () => {
    const app = await makeApp();
    const res = await app.request("/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ updates: { nope: 1 } }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: "settings.unknown_key" } });
  });

  it("returns 400 for a malformed body", async () => {
    const app = await makeApp();
    const res = await app.request("/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ wrong: true }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: "validation" } });
  });
});
```

- [ ] **Step 2: Run the test to see it fail**

Run: `pnpm --filter @docmind/server test -- settings.routes`
Expected: FAIL, cannot find module.

- [ ] **Step 3: Write the error handler, schemas, and routes**

`apps/server/src/shared/http/error-handler.ts`:
```ts
import type { ErrorHandler } from "hono";
import { isAppError } from "../errors/errors.js";
import { createLogger } from "../logger/logger.js";

const logger = createLogger("http");

export const errorHandler: ErrorHandler = (error, c) => {
  if (isAppError(error)) {
    return c.json({ error: { code: error.code, message: error.message } }, error.status as 400);
  }
  logger.error({ err: error }, "Unhandled error");
  return c.json({ error: { code: "internal", message: "Something went wrong" } }, 500);
};
```

`apps/server/src/shared/http/validate.ts` (create alongside):
```ts
import type { Context } from "hono";
import * as v from "valibot";
import { createError } from "../errors/errors.js";

export async function parseJsonBody<S extends v.GenericSchema>(c: Context, schema: S): Promise<v.InferOutput<S>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw createError({ code: "validation", message: "Body must be JSON", status: 400 });
  }
  return parseOrValidationError(schema, raw);
}

export function parseOrValidationError<S extends v.GenericSchema>(schema: S, value: unknown): v.InferOutput<S> {
  const result = v.safeParse(schema, value);
  if (!result.success) {
    const first = result.issues[0];
    const path = first?.path?.map((p) => String(p.key)).join(".");
    throw createError({
      code: "validation",
      message: `${path ? path + ": " : ""}${first?.message ?? "Invalid input"}`,
      status: 400,
    });
  }
  return result.output;
}
```

`apps/server/src/modules/settings/settings.schemas.ts`:
```ts
import * as v from "valibot";

export const updateSettingsBodySchema = v.object({
  updates: v.record(v.string(), v.unknown()),
});
```

`apps/server/src/modules/settings/settings.routes.ts`:
```ts
import type { Context, Hono } from "hono";
import { parseJsonBody } from "../../shared/http/validate.js";
import { updateSettingsBodySchema } from "./settings.schemas.js";
import type { SettingsService } from "./settings.usecases.js";

export function registerSettingsRoutes({
  app,
  settingsService,
  getUserId,
}: {
  app: Hono;
  settingsService: SettingsService;
  getUserId: (c: Context) => string;
}) {
  app.get("/api/settings", async (c) => {
    const settings = await settingsService.listResolved(getUserId(c));
    return c.json({ settings });
  });

  app.put("/api/settings", async (c) => {
    const userId = getUserId(c);
    const { updates } = await parseJsonBody(c, updateSettingsBodySchema);
    await settingsService.set(userId, updates);
    const settings = await settingsService.listResolved(userId);
    return c.json({ settings });
  });
}
```

- [ ] **Step 4: Run the test to see it pass**

Run: `pnpm --filter @docmind/server test -- settings.routes`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src
git commit -m "feat(settings): add settings routes with masked secrets and validation"
```

---

### Task 7: Storage driver interface, registry, and local driver

**Files:**
- Create: `apps/server/src/modules/storage/storage.types.ts`, `storage.registry.ts`, `storage.settings.ts`, `storage.usecases.ts`
- Create: `apps/server/src/modules/storage/drivers/local/local.driver.ts`
- Create: `apps/server/src/modules/storage/drivers/driver-contract.test-utils.ts`
- Test: `apps/server/src/modules/storage/drivers/local/local.driver.test.ts`, `apps/server/src/modules/storage/storage.usecases.test.ts`

**Interfaces:**
- Produces:
  ```ts
  type StorageDriver = {
    id: string;
    put(args: { key: string; body: Readable; mimeType?: string; sizeBytes?: number }): Promise<{ key: string }>;
    get(args: { key: string }): Promise<Readable>;
    delete(args: { key: string }): Promise<void>;
    exists(args: { key: string }): Promise<boolean>;
    healthCheck(): Promise<{ ok: boolean; message: string }>;
  };
  type StorageDriverDefinition = {
    id: string; label: string;
    settings: SettingDefinition[];
    guide: SetupGuide;
    create(args: { settings: SettingsService; userId: string }): Promise<StorageDriver>;
  };
  type SetupGuide = { title: string; intro: string; steps: { text: string; link?: string; copyValue?: string }[]; notes: string[] };
  ```
- Produces: `storageDriverRegistry` (object keyed by id) and `createStorageService({ settingsService })` with `getActiveDriver(userId)` and `getDriver(userId, driverId)`.
- Produces: `runDriverContractTests(name, makeDriver)` used by every driver's test file.
- Produces: settings `storage.activeDriver` (env `STORAGE_DRIVER`, default `local`) and `storage.local.root` (env `DOCUMENT_STORAGE_ROOT`, default `./documents`).
- Produces: `buildStorageKey({ userId, documentId, filename })` returning `userId/documentId/<sanitized filename>`.

- [ ] **Step 1: Write the contract test helper and the local driver test**

`apps/server/src/modules/storage/drivers/driver-contract.test-utils.ts`:
```ts
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import type { StorageDriver } from "../storage.types.js";

async function readAll(stream: Readable) {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

export function runDriverContractTests(name: string, makeDriver: () => Promise<StorageDriver>) {
  describe(`${name} driver contract`, () => {
    it("puts, reports existence, gets, and deletes", async () => {
      const driver = await makeDriver();
      const key = "user-1/doc-1/hello.txt";
      const { key: stored } = await driver.put({ key, body: Readable.from(["hello ", "world"]), mimeType: "text/plain" });
      expect(await driver.exists({ key: stored })).toBe(true);
      expect(await readAll(await driver.get({ key: stored }))).toBe("hello world");
      await driver.delete({ key: stored });
      expect(await driver.exists({ key: stored })).toBe(false);
    });

    it("reports a missing key as not found", async () => {
      const driver = await makeDriver();
      await expect(driver.get({ key: "user-1/none/x.txt" })).rejects.toThrow(/storage.not_found/);
      expect(await driver.exists({ key: "user-1/none/x.txt" })).toBe(false);
    });

    it("passes its health check", async () => {
      const driver = await makeDriver();
      expect(await driver.healthCheck()).toMatchObject({ ok: true });
    });

    it("streams large bodies without buffering", async () => {
      const driver = await makeDriver();
      const chunk = Buffer.alloc(1024 * 1024, 1);
      let produced = 0;
      const body = new Readable({
        read() {
          if (produced >= 8) return this.push(null);
          produced += 1;
          this.push(chunk);
        },
      });
      const { key } = await driver.put({ key: "user-1/doc-2/big.bin", body });
      let size = 0;
      for await (const c of await driver.get({ key })) size += (c as Buffer).length;
      expect(size).toBe(8 * 1024 * 1024);
      await driver.delete({ key });
    });
  });
}
```

`apps/server/src/modules/storage/drivers/local/local.driver.test.ts`:
```ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { runDriverContractTests } from "../driver-contract.test-utils.js";
import { createLocalDriver } from "./local.driver.js";

const roots: string[] = [];
async function makeDriver() {
  const root = await mkdtemp(join(tmpdir(), "docmind-local-"));
  roots.push(root);
  return createLocalDriver({ root });
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

runDriverContractTests("local", makeDriver);

describe("local driver safety", () => {
  it("rejects keys that escape the root", async () => {
    const driver = await makeDriver();
    await expect(driver.put({ key: "../escape.txt", body: Readable.from(["x"]) })).rejects.toThrow(/storage.invalid_key/);
    await expect(driver.get({ key: "user-1/../../etc/passwd" })).rejects.toThrow(/storage.invalid_key/);
  });

  it("rejects absolute keys", async () => {
    const driver = await makeDriver();
    await expect(driver.exists({ key: "/etc/passwd" })).rejects.toThrow(/storage.invalid_key/);
  });
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `pnpm --filter @docmind/server test -- local.driver`
Expected: FAIL, cannot find module.

- [ ] **Step 3: Write types, local driver, registry, settings, and service**

`apps/server/src/modules/storage/storage.types.ts`:
```ts
import type { Readable } from "node:stream";
import type { SettingDefinition } from "../settings/settings.types.js";
import type { SettingsService } from "../settings/settings.usecases.js";

export type StorageDriver = {
  id: string;
  put(args: { key: string; body: Readable; mimeType?: string; sizeBytes?: number }): Promise<{ key: string }>;
  get(args: { key: string }): Promise<Readable>;
  delete(args: { key: string }): Promise<void>;
  exists(args: { key: string }): Promise<boolean>;
  healthCheck(): Promise<{ ok: boolean; message: string }>;
};

export type SetupGuideStep = { text: string; link?: string; copyValue?: string };
export type SetupGuide = { title: string; intro: string; steps: SetupGuideStep[]; notes: string[] };

export type StorageDriverDefinition = {
  id: string;
  label: string;
  settings: SettingDefinition[];
  guide: SetupGuide;
  create(args: { settings: SettingsService; userId: string }): Promise<StorageDriver>;
};
```

`apps/server/src/modules/storage/drivers/local/local.driver.ts`:
```ts
import { createReadStream, createWriteStream } from "node:fs";
import { access, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import * as v from "valibot";
import { createError } from "../../../../shared/errors/errors.js";
import { defineSetting } from "../../../settings/settings.registry.js";
import type { StorageDriver, StorageDriverDefinition } from "../../storage.types.js";

function invalidKey(key: string) {
  return createError({ code: "storage.invalid_key", message: `Invalid storage key "${key}"`, status: 400 });
}

export function resolveInsideRoot(root: string, key: string) {
  if (!key || isAbsolute(key) || key.includes("\0")) throw invalidKey(key);
  const normalized = normalize(key);
  if (normalized.startsWith("..") || normalized.split(sep).includes("..")) throw invalidKey(key);
  const absoluteRoot = resolve(root);
  const full = resolve(absoluteRoot, normalized);
  if (full !== absoluteRoot && !full.startsWith(absoluteRoot + sep)) throw invalidKey(key);
  return full;
}

export function createLocalDriver({ root }: { root: string }): StorageDriver {
  return {
    id: "local",
    async put({ key, body }) {
      const full = resolveInsideRoot(root, key);
      await mkdir(dirname(full), { recursive: true });
      await pipeline(body, createWriteStream(full));
      return { key };
    },
    async get({ key }) {
      const full = resolveInsideRoot(root, key);
      try {
        await access(full);
      } catch {
        throw createError({ code: "storage.not_found", message: `No file at key "${key}"`, status: 404 });
      }
      return createReadStream(full) as Readable;
    },
    async delete({ key }) {
      const full = resolveInsideRoot(root, key);
      await rm(full, { force: true });
    },
    async exists({ key }) {
      const full = resolveInsideRoot(root, key);
      try {
        return (await stat(full)).isFile();
      } catch {
        return false;
      }
    },
    async healthCheck() {
      try {
        await mkdir(resolve(root), { recursive: true });
        const probe = join(resolve(root), ".docmind-health");
        await writeFile(probe, "ok");
        await rm(probe, { force: true });
        return { ok: true, message: `Writable: ${resolve(root)}` };
      } catch (error) {
        return { ok: false, message: `Cannot write to ${resolve(root)}: ${(error as Error).message}` };
      }
    },
  };
}

export const localRootSetting = defineSetting({
  key: "storage.local.root",
  schema: v.pipe(v.string(), v.minLength(1)),
  env: "DOCUMENT_STORAGE_ROOT",
  default: "./documents",
  doc: "Directory where uploaded files are stored when the local driver is active.",
});

export const localDriverDefinition: StorageDriverDefinition = {
  id: "local",
  label: "Local filesystem",
  settings: [localRootSetting],
  guide: {
    title: "Store files on this server",
    intro: "Files are written to a folder on the machine running DocMind. Good for a single VPS or a home server.",
    steps: [
      { text: "Pick a folder the DocMind process can write to. Use an absolute path in production, for example /var/lib/docmind/documents." },
      { text: "Enter that path as the storage root below and click Test. DocMind creates the folder if it is missing." },
      { text: "With Docker, mount a volume at that path so files survive container updates. See the compose file's volumes section." },
    ],
    notes: ["Back this folder up together with the database file. One without the other is not a usable backup."],
  },
  async create({ settings, userId }) {
    const root = (await settings.get<string>(userId, "storage.local.root")) ?? "./documents";
    return createLocalDriver({ root });
  },
};
```

`apps/server/src/modules/storage/storage.registry.ts`:
```ts
import { localDriverDefinition } from "./drivers/local/local.driver.js";
import type { StorageDriverDefinition } from "./storage.types.js";

export const storageDriverRegistry = {
  local: localDriverDefinition,
} as const satisfies Record<string, StorageDriverDefinition>;

export type StorageDriverId = keyof typeof storageDriverRegistry;
export const storageDriverIds = Object.keys(storageDriverRegistry) as StorageDriverId[];
```

`apps/server/src/modules/storage/storage.settings.ts`:
```ts
import * as v from "valibot";
import { defineSetting } from "../settings/settings.registry.js";
import { storageDriverIds, storageDriverRegistry } from "./storage.registry.js";

export const activeDriverSetting = defineSetting({
  key: "storage.activeDriver",
  schema: v.picklist(storageDriverIds),
  env: "STORAGE_DRIVER",
  default: "local",
  doc: "Which storage driver receives new uploads.",
});

export const storageSettingDefinitions = [
  activeDriverSetting,
  ...Object.values(storageDriverRegistry).flatMap((d) => d.settings),
];
```

`apps/server/src/modules/storage/storage.usecases.ts`:
```ts
import { basename } from "node:path";
import { createError } from "../../shared/errors/errors.js";
import type { SettingsService } from "../settings/settings.usecases.js";
import { storageDriverRegistry, type StorageDriverId } from "./storage.registry.js";

export function buildStorageKey({ userId, documentId, filename }: { userId: string; documentId: string; filename: string }) {
  const base = basename(filename.replace(/\\/g, "/"));
  const safe = base.replace(/[^\w.\-]+/g, "_").replace(/^\.+/, "").slice(0, 200) || "file";
  return `${userId}/${documentId}/${safe}`;
}

export function createStorageService({ settingsService }: { settingsService: SettingsService }) {
  return {
    async getDriver(userId: string, driverId: string) {
      const definition = storageDriverRegistry[driverId as StorageDriverId];
      if (!definition) {
        throw createError({ code: "storage.unknown_driver", message: `Unknown storage driver "${driverId}"`, status: 400 });
      }
      return definition.create({ settings: settingsService, userId });
    },
    async getActiveDriverId(userId: string) {
      return (await settingsService.get<StorageDriverId>(userId, "storage.activeDriver")) ?? "local";
    },
    async getActiveDriver(userId: string) {
      return this.getDriver(userId, await this.getActiveDriverId(userId));
    },
  };
}

export type StorageService = ReturnType<typeof createStorageService>;
```

- [ ] **Step 4: Write the service test**

`apps/server/src/modules/storage/storage.usecases.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { createTestDatabase } from "../../shared/test/database.test-utils.js";
import { createSettingsRegistry } from "../settings/settings.registry.js";
import { createSettingsService } from "../settings/settings.usecases.js";
import { storageSettingDefinitions } from "./storage.settings.js";
import { buildStorageKey, createStorageService } from "./storage.usecases.js";

describe("storage service", () => {
  it("builds safe keys", () => {
    expect(buildStorageKey({ userId: "u1", documentId: "d1", filename: "My Report (final).pdf" })).toBe("u1/d1/My_Report_final_.pdf");
    expect(buildStorageKey({ userId: "u1", documentId: "d1", filename: "../../x" })).toBe("u1/d1/x");
  });

  it("resolves the active driver from settings", async () => {
    const { db } = await createTestDatabase();
    const settingsService = createSettingsService({
      db,
      registry: createSettingsRegistry(storageSettingDefinitions),
      config: { settingsEncryptionKey: "ef".repeat(32), env: { DOCUMENT_STORAGE_ROOT: "/tmp/docmind-test-root" } },
    });
    const storage = createStorageService({ settingsService });
    expect(await storage.getActiveDriverId("u1")).toBe("local");
    const driver = await storage.getActiveDriver("u1");
    expect(driver.id).toBe("local");
    await expect(storage.getDriver("u1", "s3")).rejects.toThrow(/storage.unknown_driver/);
  });
});
```

- [ ] **Step 5: Run all storage tests**

Run: `pnpm --filter @docmind/server test -- storage`
Expected: PASS: 4 contract tests, 2 safety tests, 2 service tests.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/modules/storage
git commit -m "feat(storage): add driver interface, registry, local driver, and contract tests"
```

---

### Task 8: Auth with better-auth and a closed sign-up gate

**Files:**
- Create: `apps/server/src/modules/auth/auth.services.ts`, `auth.tables.ts`, `auth.middleware.ts`, `auth.routes.ts`
- Modify: `apps/server/src/modules/database/schema.ts`
- Test: `apps/server/src/modules/auth/auth.test.ts`

**Interfaces:**
- Produces: `createAuth({ db, config }): Auth` (better-auth instance) with email and password; sign-up succeeds only while the users table is empty.
- Produces: `sessionMiddleware(auth)` setting `c.get("user")` to `{ id, email, name }` or null, and `requireUser(c)` that throws `AppError` 401 `auth.unauthenticated` when there is no session.
- Produces: `registerAuthRoutes({ app, auth, db })` mounting `/api/auth/*` and `GET /api/auth/status` returning `{ hasUsers: boolean }` so the client can show sign up on first run.
- Tables: better-auth's `user`, `session`, `account`, `verification`, generated by its CLI into `auth.tables.ts`.

- [ ] **Step 1: Add dependencies**

```bash
pnpm --filter @docmind/server add better-auth @better-auth/drizzle-adapter
```

- [ ] **Step 2: Write the failing test**

`apps/server/src/modules/auth/auth.test.ts`:
```ts
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { errorHandler } from "../../shared/http/error-handler.js";
import { createTestDatabase } from "../../shared/test/database.test-utils.js";
import { requireUser, sessionMiddleware } from "./auth.middleware.js";
import { registerAuthRoutes } from "./auth.routes.js";
import { createAuth } from "./auth.services.js";

const config = { authSecret: "s".repeat(32), serverBaseUrl: "http://localhost:4000", clientBaseUrl: "http://localhost:5173" };

async function makeApp() {
  const { db } = await createTestDatabase();
  const auth = createAuth({ db, config });
  const app = new Hono();
  app.onError(errorHandler);
  registerAuthRoutes({ app, auth, db });
  app.get("/api/whoami", sessionMiddleware(auth), (c) => c.json({ email: requireUser(c).email }));
  return { app, auth };
}

async function signUp(app: Hono, email: string) {
  return app.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json", origin: config.clientBaseUrl },
    body: JSON.stringify({ email, password: "correct horse battery", name: "Yasam" }),
  });
}

describe("auth", () => {
  it("reports whether users exist", async () => {
    const { app } = await makeApp();
    expect(await (await app.request("/api/auth/status")).json()).toEqual({ hasUsers: false });
    expect((await signUp(app, "first@example.com")).status).toBe(200);
    expect(await (await app.request("/api/auth/status")).json()).toEqual({ hasUsers: true });
  });

  it("allows only the first sign up", async () => {
    const { app } = await makeApp();
    expect((await signUp(app, "first@example.com")).status).toBe(200);
    const second = await signUp(app, "second@example.com");
    expect(second.status).toBe(400);
  });

  it("protects routes and identifies the signed in user", async () => {
    const { app } = await makeApp();
    expect((await app.request("/api/whoami")).status).toBe(401);
    const res = await signUp(app, "first@example.com");
    const cookie = res.headers.get("set-cookie") ?? "";
    const who = await app.request("/api/whoami", { headers: { cookie } });
    expect(who.status).toBe(200);
    expect(await who.json()).toEqual({ email: "first@example.com" });
  });
});
```

- [ ] **Step 3: Run the test to see it fail**

Run: `pnpm --filter @docmind/server test -- auth`
Expected: FAIL, cannot find module.

- [ ] **Step 4: Write the auth service, then generate the tables**

`apps/server/src/modules/auth/auth.services.ts`:
```ts
import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { count } from "drizzle-orm";
import type { Database } from "../database/database.js";
import * as authTables from "./auth.tables.js";

export type AuthConfig = { authSecret: string; serverBaseUrl: string; clientBaseUrl: string };

export function createAuth({ db, config }: { db: Database; config: AuthConfig }) {
  return betterAuth({
    secret: config.authSecret,
    baseURL: config.serverBaseUrl,
    basePath: "/api/auth",
    trustedOrigins: [config.clientBaseUrl, config.serverBaseUrl],
    database: drizzleAdapter(db, { provider: "sqlite", schema: authTables }),
    emailAndPassword: { enabled: true, minPasswordLength: 12 },
    session: { cookieCache: { enabled: true, maxAge: 5 * 60 } },
    databaseHooks: {
      user: {
        create: {
          before: async () => {
            const [row] = await db.select({ n: count() }).from(authTables.user);
            if ((row?.n ?? 0) > 0) {
              throw new APIError("BAD_REQUEST", { message: "Sign up is closed. This DocMind already has its user." });
            }
          },
        },
      },
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;
```

Generate the tables. better-auth's CLI reads a config file and writes Drizzle tables. The `auth.tables.ts` import above does not exist yet, so use a temporary bootstrap config for the generator:

```bash
cd apps/server
cat > auth.generate.config.ts <<'CFG'
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { createDatabase } from "./src/modules/database/database.js";
const { db } = createDatabase({ url: ":memory:" });
export const auth = betterAuth({ database: drizzleAdapter(db, { provider: "sqlite" }), emailAndPassword: { enabled: true } });
CFG
npx @better-auth/cli@latest generate --config auth.generate.config.ts --output src/modules/auth/auth.tables.ts --yes
rm auth.generate.config.ts
cd ../..
```

Open the generated `auth.tables.ts` and confirm it exports `user`, `session`, `account`, and `verification` tables created with `sqliteTable`. If the CLI flags differ in the installed version, run `npx @better-auth/cli@latest generate --help` and adapt; if generation fails outright, write the four tables by hand from better-auth's documented core schema (user: id, name, email, emailVerified, image, createdAt, updatedAt; session: id, userId, token, expiresAt, ipAddress, userAgent, createdAt, updatedAt; account: id, userId, accountId, providerId, accessToken, refreshToken, idToken, accessTokenExpiresAt, refreshTokenExpiresAt, scope, password, createdAt, updatedAt; verification: id, identifier, value, expiresAt, createdAt, updatedAt) using snake_case column names. Then add to `schema.ts`:
```ts
export * from "../auth/auth.tables.js";
```

`apps/server/src/modules/auth/auth.middleware.ts`:
```ts
import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import { createError } from "../../shared/errors/errors.js";
import type { Auth } from "./auth.services.js";

export type SessionUser = { id: string; email: string; name: string };

export function sessionMiddleware(auth: Auth) {
  return createMiddleware(async (c, next) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    c.set("user", session ? { id: session.user.id, email: session.user.email, name: session.user.name } : null);
    await next();
  });
}

export function requireUser(c: Context): SessionUser {
  const user = c.get("user") as SessionUser | null | undefined;
  if (!user) throw createError({ code: "auth.unauthenticated", message: "Sign in required", status: 401 });
  return user;
}
```

`apps/server/src/modules/auth/auth.routes.ts`:
```ts
import type { Hono } from "hono";
import { count } from "drizzle-orm";
import type { Database } from "../database/database.js";
import type { Auth } from "./auth.services.js";
import { user as userTable } from "./auth.tables.js";

export function registerAuthRoutes({ app, auth, db }: { app: Hono; auth: Auth; db: Database }) {
  app.get("/api/auth/status", async (c) => {
    const [row] = await db.select({ n: count() }).from(userTable);
    return c.json({ hasUsers: (row?.n ?? 0) > 0 });
  });
  app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));
}
```

`/api/auth/status` is registered before the wildcard so it wins.

- [ ] **Step 5: Generate the migration and run the tests**

```bash
cd apps/server && pnpm db:generate --name auth && cd ../..
pnpm --filter @docmind/server test -- auth
```
Expected: PASS, 3 tests. If sign-up returns 403 about origin, the `origin` header in the test must match a trusted origin; better-auth checks it on state-changing requests.

- [ ] **Step 6: Commit**

```bash
git add apps/server
git commit -m "feat(auth): add better-auth with email sign in and first-user-only sign up"
```

---

### Task 9: Test app helper and server composition

**Files:**
- Create: `apps/server/src/server.ts` (composition root), `apps/server/src/shared/test/app.test-utils.ts`
- Create: `apps/server/src/modules/settings/settings.definitions.ts`
- Modify: `apps/server/src/index.ts`
- Test: `apps/server/src/server.test.ts`

**Interfaces:**
- Produces: `createServer({ config, db })` returning `{ app, auth, settingsService, storageService, getUserId }`, wiring every module, session middleware on `/api/*` after the public routes, and the error handler.
- Produces: `allSettingDefinitions` in `settings.definitions.ts`, the single list every module contributes to (storage now, AI in Milestone C).
- Produces: `createTestApp(env?)` returning `{ app, db, services, config, signIn }` where `signIn()` signs up the first user and returns `{ cookie, userId }`.
- `app.ts` keeps `createApp()` for the bare health app used in Task 1. `index.ts` loads config, creates the database, runs migrations, builds the server, and serves it.

- [ ] **Step 1: Write the failing test**

`apps/server/src/server.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { createTestApp } from "./shared/test/app.test-utils.js";

describe("server composition", () => {
  it("serves health without a session and settings only with one", async () => {
    const { app, signIn } = await createTestApp();
    expect((await app.request("/api/health")).status).toBe(200);
    expect((await app.request("/api/settings")).status).toBe(401);
    const { cookie } = await signIn();
    const res = await app.request("/api/settings", { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.settings.map((s: { key: string }) => s.key)).toContain("storage.activeDriver");
  });
});
```

- [ ] **Step 2: Run the test to see it fail**

Run: `pnpm --filter @docmind/server test -- server`
Expected: FAIL, cannot find module.

- [ ] **Step 3: Write the definitions list, composition root, and test helper**

`apps/server/src/modules/settings/settings.definitions.ts`:
```ts
import { storageSettingDefinitions } from "../storage/storage.settings.js";
import type { SettingDefinition } from "./settings.types.js";

export const allSettingDefinitions: SettingDefinition[] = [...storageSettingDefinitions];
```

`apps/server/src/server.ts`:
```ts
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import type { Config } from "./modules/config/config.js";
import type { Database } from "./modules/database/database.js";
import { requireUser, sessionMiddleware } from "./modules/auth/auth.middleware.js";
import { registerAuthRoutes } from "./modules/auth/auth.routes.js";
import { createAuth } from "./modules/auth/auth.services.js";
import { allSettingDefinitions } from "./modules/settings/settings.definitions.js";
import { createSettingsRegistry } from "./modules/settings/settings.registry.js";
import { registerSettingsRoutes } from "./modules/settings/settings.routes.js";
import { createSettingsService } from "./modules/settings/settings.usecases.js";
import { createStorageService } from "./modules/storage/storage.usecases.js";
import { errorHandler } from "./shared/http/error-handler.js";

export function createServer({ config, db }: { config: Config; db: Database }) {
  const app = new Hono();
  app.onError(errorHandler);
  app.use("/api/*", cors({ origin: [config.clientBaseUrl], credentials: true }));

  const auth = createAuth({ db, config });
  const settingsService = createSettingsService({
    db,
    registry: createSettingsRegistry(allSettingDefinitions),
    config: { settingsEncryptionKey: config.settingsEncryptionKey, env: config.env },
  });
  const storageService = createStorageService({ settingsService });

  app.get("/api/health", (c) => c.json({ status: "ok" }));
  registerAuthRoutes({ app, auth, db });

  app.use("/api/*", sessionMiddleware(auth));
  const getUserId = (c: Context) => requireUser(c).id;

  registerSettingsRoutes({ app, settingsService, getUserId });

  return { app, auth, settingsService, storageService, getUserId };
}

export type Server = ReturnType<typeof createServer>;
```

Order matters: the health and auth handlers sit before the session middleware in the dispatch chain and return a response without calling `next()`, so the middleware never runs for them.

Replace `apps/server/src/index.ts`:
```ts
import { serve } from "@hono/node-server";
import { loadConfig } from "./modules/config/config.js";
import { createDatabase } from "./modules/database/database.js";
import { runMigrations } from "./modules/database/database.usecases.js";
import { createServer } from "./server.js";
import { createLogger } from "./shared/logger/logger.js";

const logger = createLogger("main");
const config = loadConfig();
const { db } = createDatabase({ url: config.databaseUrl });
await runMigrations({ db });
const { app } = createServer({ config, db });

serve({ fetch: app.fetch, port: config.port }, (info) => {
  logger.info({ port: info.port }, "DocMind server listening");
});
```

`apps/server/src/shared/test/app.test-utils.ts`:
```ts
import { parseConfig } from "../../modules/config/config.js";
import { createServer } from "../../server.js";
import { createTestDatabase } from "./database.test-utils.js";

export async function createTestApp(env: Record<string, string> = {}) {
  const config = parseConfig({
    SETTINGS_ENCRYPTION_KEY: "11".repeat(32),
    AUTH_SECRET: "t".repeat(32),
    DATABASE_URL: ":memory:",
    ...env,
  });
  const { db } = await createTestDatabase();
  const server = createServer({ config, db });

  async function signIn(email = "owner@example.com") {
    const res = await server.app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin: config.clientBaseUrl },
      body: JSON.stringify({ email, password: "correct horse battery", name: "Owner" }),
    });
    if (res.status !== 200) throw new Error(`sign up failed: ${res.status} ${await res.text()}`);
    const body = (await res.json()) as { user: { id: string } };
    return { cookie: res.headers.get("set-cookie") ?? "", userId: body.user.id };
  }

  return { app: server.app, db, services: server, config, signIn };
}
```

- [ ] **Step 4: Run all tests**

Run: `pnpm --filter @docmind/server test`
Expected: PASS, everything so far.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src
git commit -m "feat(server): compose modules with session middleware and add test app helper"
```

---

### Task 10: Documents table, repository, and usecases

**Files:**
- Create: `apps/server/src/modules/documents/documents.tables.ts`, `documents.repository.ts`, `documents.models.ts`, `documents.usecases.ts`, `documents.types.ts`
- Modify: `apps/server/src/modules/database/schema.ts`
- Test: `apps/server/src/modules/documents/documents.models.test.ts`, `documents.usecases.test.ts`

**Interfaces:**
- Produces: `createDocumentsService({ db, storageService })` with:
  - `upload({ userId, name, mimeType, body: Readable }): Promise<{ document: Document; duplicateOf?: string }>`. Streams to the active driver while hashing and counting bytes. If a document with the same hash exists for the user, the stored file is deleted again and the existing document is returned with `duplicateOf` set to its id.
  - `list({ userId }): Promise<Document[]>` newest first
  - `get({ userId, documentId }): Promise<Document>` (404 `documents.not_found`)
  - `rename({ userId, documentId, name }): Promise<Document>`
  - `remove({ userId, documentId })` deleting the file then the row
  - `openFile({ userId, documentId }): Promise<{ document: Document; stream: Readable }>`
- Produces: `hashingCounter()` in `documents.models.ts`: `{ transform: Transform, result(): { sha256, sizeBytes } }`.
- Produces: `sanitizeFilename(name): string`, `newDocumentId(): string` (`doc_` plus 16 hex chars), `nowIso()`.
- Table `documents` per the spec: `id, user_id, name, mime_type, size_bytes, content_hash, storage_driver, storage_key, extracted_text, extraction_status, extraction_error, rule_status, rule_error, embedding_status, embedding_error, created_at, updated_at`. Status columns default to `pending`; later milestones drive them.

- [ ] **Step 1: Write the failing model test**

`apps/server/src/modules/documents/documents.models.test.ts`:
```ts
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { describe, expect, it } from "vitest";
import { hashingCounter, newDocumentId, sanitizeFilename } from "./documents.models.js";

describe("documents models", () => {
  it("hashes and counts bytes while passing data through", async () => {
    const counter = hashingCounter();
    const out: Buffer[] = [];
    await pipeline(Readable.from([Buffer.from("hello "), Buffer.from("world")]), counter.transform, async function* (source) {
      for await (const chunk of source) out.push(chunk as Buffer);
    });
    expect(Buffer.concat(out).toString()).toBe("hello world");
    expect(counter.result()).toEqual({
      sha256: createHash("sha256").update("hello world").digest("hex"),
      sizeBytes: 11,
    });
  });

  it("sanitizes file names", () => {
    expect(sanitizeFilename("  My Report (final).PDF ")).toBe("My Report (final).PDF");
    expect(sanitizeFilename("../../etc/passwd")).toBe("passwd");
    expect(sanitizeFilename("")).toBe("untitled");
  });

  it("makes prefixed ids", () => {
    expect(newDocumentId()).toMatch(/^doc_[0-9a-f]{16}$/);
  });
});
```

- [ ] **Step 2: Write the failing usecase test**

`apps/server/src/modules/documents/documents.usecases.test.ts`:
```ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDatabase } from "../../shared/test/database.test-utils.js";
import { createSettingsRegistry } from "../settings/settings.registry.js";
import { createSettingsService } from "../settings/settings.usecases.js";
import { storageSettingDefinitions } from "../storage/storage.settings.js";
import { createStorageService } from "../storage/storage.usecases.js";
import { createDocumentsService } from "./documents.usecases.js";

let root: string;
let documents: ReturnType<typeof createDocumentsService>;
const userId = "user-1";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "docmind-docs-"));
  const { db } = await createTestDatabase();
  const settingsService = createSettingsService({
    db,
    registry: createSettingsRegistry(storageSettingDefinitions),
    config: { settingsEncryptionKey: "22".repeat(32), env: { DOCUMENT_STORAGE_ROOT: root } },
  });
  documents = createDocumentsService({ db, storageService: createStorageService({ settingsService }) });
});
afterEach(() => rm(root, { recursive: true, force: true }));

async function readAll(stream: Readable) {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks).toString();
}

describe("documents service", () => {
  it("uploads, stores, and reads back a file", async () => {
    const { document, duplicateOf } = await documents.upload({ userId, name: "notes.txt", mimeType: "text/plain", body: Readable.from(["hello"]) });
    expect(duplicateOf).toBeUndefined();
    expect(document).toMatchObject({ name: "notes.txt", mimeType: "text/plain", sizeBytes: 5, storageDriver: "local", extractionStatus: "pending" });
    expect(document.storageKey).toBe(`${userId}/${document.id}/notes.txt`);
    const { stream } = await documents.openFile({ userId, documentId: document.id });
    expect(await readAll(stream)).toBe("hello");
  });

  it("detects duplicates by content hash and keeps one file", async () => {
    const first = await documents.upload({ userId, name: "a.txt", mimeType: "text/plain", body: Readable.from(["same"]) });
    const second = await documents.upload({ userId, name: "b.txt", mimeType: "text/plain", body: Readable.from(["same"]) });
    expect(second.duplicateOf).toBe(first.document.id);
    expect(second.document.id).toBe(first.document.id);
    expect((await documents.list({ userId })).length).toBe(1);
  });

  it("lists newest first, renames, and removes with the file", async () => {
    const a = await documents.upload({ userId, name: "a.txt", mimeType: "text/plain", body: Readable.from(["a"]) });
    const b = await documents.upload({ userId, name: "b.txt", mimeType: "text/plain", body: Readable.from(["b"]) });
    expect((await documents.list({ userId })).map((d) => d.id)).toEqual([b.document.id, a.document.id]);
    await documents.rename({ userId, documentId: a.document.id, name: "renamed.txt" });
    expect((await documents.get({ userId, documentId: a.document.id })).name).toBe("renamed.txt");
    await documents.remove({ userId, documentId: a.document.id });
    await expect(documents.get({ userId, documentId: a.document.id })).rejects.toThrow(/documents.not_found/);
  });

  it("scopes everything by user", async () => {
    const { document } = await documents.upload({ userId, name: "a.txt", mimeType: "text/plain", body: Readable.from(["a"]) });
    await expect(documents.get({ userId: "someone-else", documentId: document.id })).rejects.toThrow(/documents.not_found/);
    expect(await documents.list({ userId: "someone-else" })).toEqual([]);
  });
});
```

Two uploads in the same millisecond can share `createdAt`; the repository orders by `createdAt` then `id` descending, and ids are random, so if the "newest first" assertion is flaky, insert a one millisecond wait between the two uploads in that test.

- [ ] **Step 3: Run the tests to see them fail**

Run: `pnpm --filter @docmind/server test -- documents`
Expected: FAIL, cannot find module.

- [ ] **Step 4: Write tables, models, repository, and usecases**

`apps/server/src/modules/documents/documents.tables.ts`:
```ts
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const documentsTable = sqliteTable("documents", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  name: text("name").notNull(),
  mimeType: text("mime_type"),
  sizeBytes: integer("size_bytes"),
  contentHash: text("content_hash"),
  storageDriver: text("storage_driver").notNull(),
  storageKey: text("storage_key").notNull(),
  extractedText: text("extracted_text"),
  extractionStatus: text("extraction_status").notNull().default("pending"),
  extractionError: text("extraction_error"),
  ruleStatus: text("rule_status").notNull().default("pending"),
  ruleError: text("rule_error"),
  embeddingStatus: text("embedding_status").notNull().default("pending"),
  embeddingError: text("embedding_error"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});
```

Add to `schema.ts`:
```ts
export * from "../documents/documents.tables.js";
```

`apps/server/src/modules/documents/documents.types.ts`:
```ts
import type { documentsTable } from "./documents.tables.js";

export type Document = typeof documentsTable.$inferSelect;
export type NewDocument = typeof documentsTable.$inferInsert;
```

`apps/server/src/modules/documents/documents.models.ts`:
```ts
import { createHash, randomBytes } from "node:crypto";
import { basename } from "node:path";
import { Transform } from "node:stream";

export function newDocumentId() {
  return `doc_${randomBytes(8).toString("hex")}`;
}

export function sanitizeFilename(name: string) {
  const base = basename(name.trim().replace(/\\/g, "/")).replace(/\p{Cc}/gu, "").trim();
  return base.length > 0 ? base.slice(0, 255) : "untitled";
}

export function hashingCounter() {
  const hash = createHash("sha256");
  let sizeBytes = 0;
  const transform = new Transform({
    transform(chunk, _encoding, callback) {
      hash.update(chunk);
      sizeBytes += chunk.length;
      callback(null, chunk);
    },
  });
  return {
    transform,
    result() {
      return { sha256: hash.digest("hex"), sizeBytes };
    },
  };
}

export function nowIso() {
  return new Date().toISOString();
}
```

`apps/server/src/modules/documents/documents.repository.ts`:
```ts
import { and, desc, eq } from "drizzle-orm";
import type { Database } from "../database/database.js";
import { documentsTable } from "./documents.tables.js";
import type { NewDocument } from "./documents.types.js";

export function createDocumentsRepository({ db }: { db: Database }) {
  return {
    async insert(document: NewDocument) {
      await db.insert(documentsTable).values(document);
    },
    async listByUser(userId: string) {
      return db
        .select()
        .from(documentsTable)
        .where(eq(documentsTable.userId, userId))
        .orderBy(desc(documentsTable.createdAt), desc(documentsTable.id));
    },
    async findById({ userId, documentId }: { userId: string; documentId: string }) {
      const [row] = await db
        .select()
        .from(documentsTable)
        .where(and(eq(documentsTable.userId, userId), eq(documentsTable.id, documentId)));
      return row ?? null;
    },
    async findByHash({ userId, contentHash }: { userId: string; contentHash: string }) {
      const [row] = await db
        .select()
        .from(documentsTable)
        .where(and(eq(documentsTable.userId, userId), eq(documentsTable.contentHash, contentHash)));
      return row ?? null;
    },
    async update({ userId, documentId, patch }: { userId: string; documentId: string; patch: Partial<NewDocument> }) {
      await db
        .update(documentsTable)
        .set(patch)
        .where(and(eq(documentsTable.userId, userId), eq(documentsTable.id, documentId)));
    },
    async remove({ userId, documentId }: { userId: string; documentId: string }) {
      await db.delete(documentsTable).where(and(eq(documentsTable.userId, userId), eq(documentsTable.id, documentId)));
    },
  };
}
```

`apps/server/src/modules/documents/documents.usecases.ts`:
```ts
import { PassThrough, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createError } from "../../shared/errors/errors.js";
import type { Database } from "../database/database.js";
import { buildStorageKey, type StorageService } from "../storage/storage.usecases.js";
import { hashingCounter, newDocumentId, nowIso, sanitizeFilename } from "./documents.models.js";
import { createDocumentsRepository } from "./documents.repository.js";
import type { Document } from "./documents.types.js";

function notFound(documentId: string) {
  return createError({ code: "documents.not_found", message: `Document "${documentId}" not found`, status: 404 });
}

export function createDocumentsService({ db, storageService }: { db: Database; storageService: StorageService }) {
  const repository = createDocumentsRepository({ db });

  async function getOrThrow(userId: string, documentId: string): Promise<Document> {
    const document = await repository.findById({ userId, documentId });
    if (!document) throw notFound(documentId);
    return document;
  }

  return {
    async upload({ userId, name, mimeType, body }: { userId: string; name: string; mimeType?: string; body: Readable }) {
      const documentId = newDocumentId();
      const safeName = sanitizeFilename(name);
      const driverId = await storageService.getActiveDriverId(userId);
      const driver = await storageService.getDriver(userId, driverId);
      const key = buildStorageKey({ userId, documentId, filename: safeName });

      const counter = hashingCounter();
      const toStorage = new PassThrough();
      const [, stored] = await Promise.all([
        pipeline(body, counter.transform, toStorage),
        driver.put({ key, body: toStorage, mimeType }),
      ]);
      const { sha256, sizeBytes } = counter.result();

      const existing = await repository.findByHash({ userId, contentHash: sha256 });
      if (existing) {
        await driver.delete({ key: stored.key });
        return { document: existing, duplicateOf: existing.id };
      }

      const timestamp = nowIso();
      const document: Document = {
        id: documentId,
        userId,
        name: safeName,
        mimeType: mimeType ?? null,
        sizeBytes,
        contentHash: sha256,
        storageDriver: driverId,
        storageKey: stored.key,
        extractedText: null,
        extractionStatus: "pending",
        extractionError: null,
        ruleStatus: "pending",
        ruleError: null,
        embeddingStatus: "pending",
        embeddingError: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      await repository.insert(document);
      return { document };
    },

    list({ userId }: { userId: string }) {
      return repository.listByUser(userId);
    },

    get({ userId, documentId }: { userId: string; documentId: string }) {
      return getOrThrow(userId, documentId);
    },

    async rename({ userId, documentId, name }: { userId: string; documentId: string; name: string }) {
      await getOrThrow(userId, documentId);
      await repository.update({ userId, documentId, patch: { name: sanitizeFilename(name), updatedAt: nowIso() } });
      return getOrThrow(userId, documentId);
    },

    async remove({ userId, documentId }: { userId: string; documentId: string }) {
      const document = await getOrThrow(userId, documentId);
      const driver = await storageService.getDriver(userId, document.storageDriver);
      await driver.delete({ key: document.storageKey });
      await repository.remove({ userId, documentId });
    },

    async openFile({ userId, documentId }: { userId: string; documentId: string }) {
      const document = await getOrThrow(userId, documentId);
      const driver = await storageService.getDriver(userId, document.storageDriver);
      const stream = await driver.get({ key: document.storageKey });
      return { document, stream };
    },
  };
}

export type DocumentsService = ReturnType<typeof createDocumentsService>;
```

- [ ] **Step 5: Generate the migration and run the tests**

```bash
cd apps/server && pnpm db:generate --name documents && cd ../..
pnpm --filter @docmind/server test -- documents
```
Expected: PASS, 3 model tests and 4 usecase tests.

- [ ] **Step 6: Commit**

```bash
git add apps/server
git commit -m "feat(documents): add table, streamed upload with hashing, duplicate detection, and CRUD"
```

---

### Task 11: Documents routes

**Files:**
- Create: `apps/server/src/modules/documents/documents.routes.ts`, `documents.schemas.ts`
- Modify: `apps/server/src/server.ts`
- Test: `apps/server/src/modules/documents/documents.routes.test.ts`

**Interfaces:**
- Consumes: `DocumentsService` (Task 10), `createTestApp` (Task 9), `parseJsonBody` and `parseOrValidationError` (Task 6).
- Produces routes, all behind the session:
  - `POST /api/documents?name=<filename>` with the raw file as the body and `Content-Type` as the file's MIME type. Returns 201 `{ document }`, or 200 `{ document, duplicateOf }` when the content already exists.
  - `GET /api/documents` returns `{ documents }`.
  - `GET /api/documents/:id` returns `{ document }`.
  - `GET /api/documents/:id/file` streams the file with the stored MIME type and `Content-Disposition: inline; filename="..."`. `?download=1` switches to `attachment`.
  - `PATCH /api/documents/:id` with body `{ name }` returns `{ document }`.
  - `DELETE /api/documents/:id` returns 204.
- Upload uses the raw request body, not multipart, so it streams without a parser. The client sends `fetch(url, { method: "POST", body: file })`.
- Upload size limit: 100 MB, checked against `Content-Length` before reading, returning 413 `documents.too_large`. A settings key for this arrives in Milestone C.

- [ ] **Step 1: Write the failing test**

`apps/server/src/modules/documents/documents.routes.test.ts`:
```ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestApp } from "../../shared/test/app.test-utils.js";

let root: string;
let app: Awaited<ReturnType<typeof createTestApp>>["app"];
let cookie: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "docmind-routes-"));
  const t = await createTestApp({ DOCUMENT_STORAGE_ROOT: root });
  app = t.app;
  cookie = (await t.signIn()).cookie;
});
afterEach(() => rm(root, { recursive: true, force: true }));

function upload(name: string, content: string, type = "text/plain") {
  return app.request(`/api/documents?name=${encodeURIComponent(name)}`, {
    method: "POST",
    headers: { cookie, "content-type": type, "content-length": String(Buffer.byteLength(content)) },
    body: content,
  });
}

describe("documents routes", () => {
  it("requires a session", async () => {
    expect((await app.request("/api/documents")).status).toBe(401);
  });

  it("uploads, lists, fetches, streams, renames, and deletes", async () => {
    const created = await upload("hello.txt", "hello world");
    expect(created.status).toBe(201);
    const { document } = await created.json();
    expect(document.name).toBe("hello.txt");

    const list = await (await app.request("/api/documents", { headers: { cookie } })).json();
    expect(list.documents.map((d: { id: string }) => d.id)).toEqual([document.id]);

    const file = await app.request(`/api/documents/${document.id}/file`, { headers: { cookie } });
    expect(file.status).toBe(200);
    expect(file.headers.get("content-type")).toContain("text/plain");
    expect(file.headers.get("content-disposition")).toContain('inline; filename="hello.txt"');
    expect(await file.text()).toBe("hello world");

    const renamed = await app.request(`/api/documents/${document.id}`, {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "renamed.txt" }),
    });
    expect((await renamed.json()).document.name).toBe("renamed.txt");

    expect((await app.request(`/api/documents/${document.id}`, { method: "DELETE", headers: { cookie } })).status).toBe(204);
    expect((await app.request(`/api/documents/${document.id}`, { headers: { cookie } })).status).toBe(404);
  });

  it("reports duplicates with 200 and duplicateOf", async () => {
    const first = await (await upload("a.txt", "same bytes")).json();
    const second = await upload("b.txt", "same bytes");
    expect(second.status).toBe(200);
    expect((await second.json()).duplicateOf).toBe(first.document.id);
  });

  it("rejects a missing name and an oversized upload before reading", async () => {
    const noName = await app.request("/api/documents", { method: "POST", headers: { cookie, "content-type": "text/plain" }, body: "x" });
    expect(noName.status).toBe(400);
    const big = await app.request("/api/documents?name=big.bin", {
      method: "POST",
      headers: { cookie, "content-type": "application/octet-stream", "content-length": String(200 * 1024 * 1024) },
      body: "not actually big",
    });
    expect(big.status).toBe(413);
  });
});
```

- [ ] **Step 2: Run the test to see it fail**

Run: `pnpm --filter @docmind/server test -- documents.routes`
Expected: FAIL with 404s because the routes do not exist.

- [ ] **Step 3: Write schemas and routes, then wire them**

`apps/server/src/modules/documents/documents.schemas.ts`:
```ts
import * as v from "valibot";

export const uploadQuerySchema = v.object({
  name: v.pipe(v.string(), v.minLength(1), v.maxLength(255)),
});

export const renameBodySchema = v.object({
  name: v.pipe(v.string(), v.minLength(1), v.maxLength(255)),
});

export const documentIdSchema = v.pipe(v.string(), v.regex(/^doc_[0-9a-f]{16}$/));
```

`apps/server/src/modules/documents/documents.routes.ts`:
```ts
import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import type { Context, Hono } from "hono";
import { stream } from "hono/streaming";
import { createError } from "../../shared/errors/errors.js";
import { parseJsonBody, parseOrValidationError } from "../../shared/http/validate.js";
import { documentIdSchema, renameBodySchema, uploadQuerySchema } from "./documents.schemas.js";
import type { DocumentsService } from "./documents.usecases.js";

export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

export function registerDocumentsRoutes({
  app,
  documentsService,
  getUserId,
}: {
  app: Hono;
  documentsService: DocumentsService;
  getUserId: (c: Context) => string;
}) {
  app.post("/api/documents", async (c) => {
    const userId = getUserId(c);
    const { name } = parseOrValidationError(uploadQuerySchema, c.req.query());
    const declared = Number(c.req.header("content-length") ?? "0");
    if (declared > MAX_UPLOAD_BYTES) {
      throw createError({ code: "documents.too_large", message: `Uploads are limited to ${MAX_UPLOAD_BYTES} bytes`, status: 413 });
    }
    if (!c.req.raw.body) throw createError({ code: "validation", message: "Request body is required", status: 400 });
    const body = Readable.fromWeb(c.req.raw.body as unknown as NodeReadableStream);
    const mimeType = c.req.header("content-type")?.split(";")[0]?.trim() || "application/octet-stream";
    const result = await documentsService.upload({ userId, name, mimeType, body });
    return c.json(result, result.duplicateOf ? 200 : 201);
  });

  app.get("/api/documents", async (c) => {
    const documents = await documentsService.list({ userId: getUserId(c) });
    return c.json({ documents });
  });

  app.get("/api/documents/:id", async (c) => {
    const documentId = parseOrValidationError(documentIdSchema, c.req.param("id"));
    const document = await documentsService.get({ userId: getUserId(c), documentId });
    return c.json({ document });
  });

  app.get("/api/documents/:id/file", async (c) => {
    const documentId = parseOrValidationError(documentIdSchema, c.req.param("id"));
    const { document, stream: file } = await documentsService.openFile({ userId: getUserId(c), documentId });
    const disposition = c.req.query("download") ? "attachment" : "inline";
    c.header("Content-Type", document.mimeType ?? "application/octet-stream");
    c.header("Content-Disposition", `${disposition}; filename="${encodeURIComponent(document.name)}"`);
    if (document.sizeBytes) c.header("Content-Length", String(document.sizeBytes));
    return stream(c, async (out) => {
      for await (const chunk of file) await out.write(chunk as Uint8Array);
    });
  });

  app.patch("/api/documents/:id", async (c) => {
    const documentId = parseOrValidationError(documentIdSchema, c.req.param("id"));
    const { name } = await parseJsonBody(c, renameBodySchema);
    const document = await documentsService.rename({ userId: getUserId(c), documentId, name });
    return c.json({ document });
  });

  app.delete("/api/documents/:id", async (c) => {
    const documentId = parseOrValidationError(documentIdSchema, c.req.param("id"));
    await documentsService.remove({ userId: getUserId(c), documentId });
    return c.body(null, 204);
  });
}
```

In `apps/server/src/server.ts`, add two imports and three lines:
```ts
import { registerDocumentsRoutes } from "./modules/documents/documents.routes.js";
import { createDocumentsService } from "./modules/documents/documents.usecases.js";
```
Inside `createServer`, right after `storageService` is created:
```ts
const documentsService = createDocumentsService({ db, storageService });
```
After `registerSettingsRoutes(...)`:
```ts
registerDocumentsRoutes({ app, documentsService, getUserId });
```
And add `documentsService` to the returned object.

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @docmind/server test`
Expected: PASS. If the streamed file test hangs, check that the `stream()` callback awaits every write and that the Readable ends; `createReadStream` ends on EOF.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src
git commit -m "feat(documents): add upload, list, file streaming, rename, and delete routes"
```

---

### Task 12: Client scaffold, API client, and sign in

**Files:**
- Create: `apps/client/package.json`, `apps/client/tsconfig.json`, `apps/client/vite.config.ts`, `apps/client/index.html`, `apps/client/vitest.config.ts`, `apps/client/components.json`
- Create: `apps/client/src/main.tsx`, `apps/client/src/App.tsx`, `apps/client/src/index.css`
- Create: `apps/client/src/lib/api.ts`, `apps/client/src/lib/auth-client.ts`, `apps/client/src/lib/format.ts`
- Create: `apps/client/src/pages/auth/SignInPage.tsx`
- Create: `apps/client/src/components/layout/AppShell.tsx`
- Test: `apps/client/src/lib/api.test.ts`, `apps/client/src/lib/format.test.ts`

**Interfaces:**
- Produces: `api.get<T>(path)`, `api.json<T>(method, path, body)`, `api.del(path)`, all throwing `ApiError { code, message, status }` on non-2xx using the server's `{ error: { code, message } }` shape. Requests go to `/api/...` on the same origin; Vite proxies `/api` to the server in dev.
- Produces: `authClient` from `better-auth/react` with `useSession`, `signIn.email`, `signUp.email`, `signOut`.
- Produces: `formatBytes(n)` and `formatDate(iso)`.
- Produces: `AppShell` with a sidebar (Documents, Rules, Jobs, Settings; the last three are placeholders until later milestones) and an outlet.
- The client uses shadcn/ui components: `button`, `card`, `input`, `label`, `table`, `dialog`, `dropdown-menu`, `badge`, `sonner`.

- [ ] **Step 1: Scaffold the client**

From the repo root:
```bash
pnpm create vite@latest apps/client --template react-ts
cd apps/client
pnpm add react-router-dom @tanstack/react-query better-auth
pnpm add -D tailwindcss @tailwindcss/vite vitest @testing-library/react @testing-library/jest-dom jsdom @types/node
pnpm dlx shadcn@latest init --defaults
pnpm dlx shadcn@latest add button card input label table dialog dropdown-menu badge sonner
cd ../..
```
If `shadcn init` asks, choose: TypeScript yes, style New York, base color neutral, CSS file `src/index.css`, import alias `@/*`. Confirm `components.json` exists afterwards.

Set the package name and scripts in `apps/client/package.json`:
```json
{
  "name": "@docmind/client",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "typecheck": "tsc -b --noEmit",
    "test": "vitest run",
    "preview": "vite preview"
  }
}
```
Keep the dependency blocks the scaffold and the installs produced.

`apps/client/vite.config.ts`:
```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  server: {
    port: 5173,
    proxy: { "/api": { target: "http://localhost:4000", changeOrigin: false } },
  },
});
```

`apps/client/vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: { environment: "jsdom", include: ["src/**/*.test.{ts,tsx}"], setupFiles: ["./src/test-setup.ts"] },
});
```

`apps/client/src/test-setup.ts`:
```ts
import "@testing-library/jest-dom/vitest";
```

- [ ] **Step 2: Write the failing tests**

`apps/client/src/lib/format.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { formatBytes } from "./format";

describe("formatBytes", () => {
  it("formats sizes", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1023)).toBe("1023 B");
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
  });
});
```

`apps/client/src/lib/api.test.ts`:
```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, ApiError } from "./api";

afterEach(() => vi.restoreAllMocks());

describe("api client", () => {
  it("returns parsed JSON on success", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ ok: 1 }), { status: 200 }));
    expect(await api.get<{ ok: number }>("/api/health")).toEqual({ ok: 1 });
  });

  it("throws ApiError with the server code on failure", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: { code: "documents.not_found", message: "nope" } }), { status: 404 }),
    );
    await expect(api.get("/api/documents/doc_x")).rejects.toMatchObject({ code: "documents.not_found", status: 404 } satisfies Partial<ApiError>);
  });
});
```

- [ ] **Step 3: Run the tests to see them fail**

Run: `pnpm --filter @docmind/client test`
Expected: FAIL, cannot find modules.

- [ ] **Step 4: Write the lib files, shell, sign in page, and app**

`apps/client/src/lib/format.ts`:
```ts
export function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB"];
  let value = n / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(1)} ${units[i]}`;
}

export function formatDate(iso: string) {
  return new Date(iso).toLocaleString();
}
```

`apps/client/src/lib/api.ts`:
```ts
export class ApiError extends Error {
  code: string;
  status: number;
  constructor({ code, message, status }: { code: string; message: string; status: number }) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

async function handle<T>(res: Response): Promise<T> {
  if (res.ok) {
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }
  let code = "http_error";
  let message = res.statusText || "Request failed";
  try {
    const body = (await res.json()) as { error?: { code?: string; message?: string } };
    code = body.error?.code ?? code;
    message = body.error?.message ?? message;
  } catch {
    // body was not JSON
  }
  throw new ApiError({ code, message, status: res.status });
}

export const api = {
  get<T>(path: string) {
    return fetch(path, { credentials: "include" }).then((r) => handle<T>(r));
  },
  json<T>(method: "POST" | "PUT" | "PATCH", path: string, body: unknown) {
    return fetch(path, {
      method,
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).then((r) => handle<T>(r));
  },
  del(path: string) {
    return fetch(path, { method: "DELETE", credentials: "include" }).then((r) => handle<void>(r));
  },
};
```

`apps/client/src/lib/auth-client.ts`:
```ts
import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient({ basePath: "/api/auth" });
```

`apps/client/src/components/layout/AppShell.tsx`:
```tsx
import { NavLink, Outlet } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth-client";

const links = [
  { to: "/documents", label: "Documents" },
  { to: "/rules", label: "Rules" },
  { to: "/jobs", label: "Jobs" },
  { to: "/settings", label: "Settings" },
];

export function AppShell() {
  return (
    <div className="flex min-h-screen">
      <aside className="w-56 border-r p-4 flex flex-col gap-2">
        <div className="text-lg font-semibold mb-4">DocMind</div>
        {links.map((l) => (
          <NavLink
            key={l.to}
            to={l.to}
            className={({ isActive }) => `rounded px-3 py-2 text-sm ${isActive ? "bg-muted font-medium" : "hover:bg-muted"}`}
          >
            {l.label}
          </NavLink>
        ))}
        <div className="mt-auto">
          <Button variant="ghost" className="w-full" onClick={() => authClient.signOut().then(() => window.location.assign("/sign-in"))}>
            Sign out
          </Button>
        </div>
      </aside>
      <main className="flex-1 p-6">
        <Outlet />
      </main>
    </div>
  );
}
```

`apps/client/src/pages/auth/SignInPage.tsx`:
```tsx
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/api";
import { authClient } from "@/lib/auth-client";

export function SignInPage() {
  const navigate = useNavigate();
  const [hasUsers, setHasUsers] = useState<boolean | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get<{ hasUsers: boolean }>("/api/auth/status").then((s) => setHasUsers(s.hasUsers));
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const result = hasUsers
      ? await authClient.signIn.email({ email, password })
      : await authClient.signUp.email({ email, password, name: name || email });
    setBusy(false);
    if (result.error) {
      setError(result.error.message ?? "Sign in failed");
      return;
    }
    navigate("/documents");
  }

  if (hasUsers === null) return null;

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>{hasUsers ? "Sign in to DocMind" : "Create your DocMind account"}</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="flex flex-col gap-3">
            {!hasUsers && (
              <div>
                <Label htmlFor="name">Name</Label>
                <Input id="name" value={name} onChange={(e) => setName(e.target.value)} />
              </div>
            )}
            <div>
              <Label htmlFor="email">Email</Label>
              <Input id="email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="password">Password</Label>
              <Input id="password" type="password" required minLength={12} value={password} onChange={(e) => setPassword(e.target.value)} />
              {!hasUsers && <p className="text-xs text-muted-foreground mt-1">At least 12 characters. This is the only account; sign up closes after it.</p>}
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <Button type="submit" disabled={busy}>
              {hasUsers ? "Sign in" : "Create account"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
```

`apps/client/src/App.tsx`:
```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { Toaster } from "@/components/ui/sonner";
import { AppShell } from "@/components/layout/AppShell";
import { authClient } from "@/lib/auth-client";
import { SignInPage } from "@/pages/auth/SignInPage";
import { DocumentsPage } from "@/pages/documents/DocumentsPage";
import { DocumentDetailPage } from "@/pages/documents/DocumentDetailPage";

const queryClient = new QueryClient();

function RequireSession({ children }: { children: React.ReactNode }) {
  const { data, isPending } = authClient.useSession();
  if (isPending) return null;
  if (!data) return <Navigate to="/sign-in" replace />;
  return <>{children}</>;
}

function Placeholder({ title }: { title: string }) {
  return <h1 className="text-xl font-semibold">{title} arrives in a later milestone</h1>;
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route path="/sign-in" element={<SignInPage />} />
          <Route
            element={
              <RequireSession>
                <AppShell />
              </RequireSession>
            }
          >
            <Route index element={<Navigate to="/documents" replace />} />
            <Route path="/documents" element={<DocumentsPage />} />
            <Route path="/documents/:id" element={<DocumentDetailPage />} />
            <Route path="/rules" element={<Placeholder title="Rules" />} />
            <Route path="/jobs" element={<Placeholder title="Jobs" />} />
            <Route path="/settings" element={<Placeholder title="Settings" />} />
          </Route>
        </Routes>
      </BrowserRouter>
      <Toaster />
    </QueryClientProvider>
  );
}
```

`apps/client/src/main.tsx`:
```tsx
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
```

The two documents pages are created in Task 13. Until then, create them as one-line stubs so the app compiles:
`apps/client/src/pages/documents/DocumentsPage.tsx`: `export function DocumentsPage() { return <h1>Documents</h1>; }`
`apps/client/src/pages/documents/DocumentDetailPage.tsx`: `export function DocumentDetailPage() { return <h1>Document</h1>; }`

- [ ] **Step 5: Run the tests and typecheck**

Run: `pnpm --filter @docmind/client test && pnpm --filter @docmind/client typecheck`
Expected: PASS, 3 tests; typecheck clean.

- [ ] **Step 6: Smoke the sign in flow by hand**

Two terminals from the repo root, with `apps/server/.env` filled from `.env.example`:
```bash
pnpm --filter @docmind/server dev
pnpm --filter @docmind/client dev
```
Open http://localhost:5173. Expected: the create account form. Create the account, land on Documents. Reload: still signed in. Sign out: back to sign in, and the form now says "Sign in", not "Create".

- [ ] **Step 7: Commit**

```bash
git add apps/client pnpm-lock.yaml
git commit -m "feat(client): scaffold React app with shadcn, API client, and sign in"
```

---

### Task 13: Documents pages with upload, preview, rename, and delete

**Files:**
- Create: `apps/client/src/lib/documents-api.ts`, `apps/client/src/pages/documents/DocumentsPage.tsx`, `apps/client/src/pages/documents/DocumentDetailPage.tsx`, `apps/client/src/components/documents/UploadDropzone.tsx`
- Test: `apps/client/src/lib/documents-api.test.ts`, `apps/client/src/components/documents/UploadDropzone.test.tsx`

**Interfaces:**
- Consumes: `api` (Task 12), the routes from Task 11.
- Produces: `documentsApi.list()`, `.get(id)`, `.rename(id, name)`, `.remove(id)`, `.upload(file, onProgress): Promise<UploadResult>` using `XMLHttpRequest` for progress events, sending the raw file as the body with `?name=`.
- Produces: `UploadDropzone({ onUploaded })` accepting drag and drop and a file picker, uploading files one at a time with a progress bar per file, and a toast on duplicate ("Already in your library as <name>").
- Produces: `DocumentsPage` listing documents in a table (name, type, size, added, extraction status badge) with links to the detail page.
- Produces: `DocumentDetailPage` showing metadata, an inline preview (`<iframe>` for PDF, `<img>` for images, a "Download" button otherwise), rename via a dialog, and delete with a confirm dialog that states the consequence.

- [ ] **Step 1: Write the failing tests**

`apps/client/src/lib/documents-api.test.ts`:
```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { documentsApi } from "./documents-api";

afterEach(() => vi.restoreAllMocks());

describe("documentsApi", () => {
  it("lists documents", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ documents: [{ id: "doc_1" }] }), { status: 200 }));
    expect(await documentsApi.list()).toEqual([{ id: "doc_1" }]);
  });

  it("uploads with the file name in the query and reports progress", async () => {
    const sent: { url?: string; method?: string; body?: unknown } = {};
    class FakeXhr {
      upload = { addEventListener: (_: string, cb: (e: ProgressEvent) => void) => setTimeout(() => cb({ lengthComputable: true, loaded: 5, total: 10 } as ProgressEvent), 0) };
      status = 201;
      responseText = JSON.stringify({ document: { id: "doc_2", name: "a.txt" } });
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      open(method: string, url: string) {
        sent.method = method;
        sent.url = url;
      }
      setRequestHeader() {}
      send(body: unknown) {
        sent.body = body;
        setTimeout(() => this.onload?.(), 1);
      }
    }
    vi.stubGlobal("XMLHttpRequest", FakeXhr);
    const progress: number[] = [];
    const file = new File(["hello"], "a.txt", { type: "text/plain" });
    const result = await documentsApi.upload(file, (p) => progress.push(p));
    expect(sent.method).toBe("POST");
    expect(sent.url).toBe("/api/documents?name=a.txt");
    expect(sent.body).toBe(file);
    expect(result.document.id).toBe("doc_2");
    expect(progress).toContain(50);
    vi.unstubAllGlobals();
  });
});
```

`apps/client/src/components/documents/UploadDropzone.test.tsx`:
```tsx
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { UploadDropzone } from "./UploadDropzone";

vi.mock("@/lib/documents-api", () => ({
  documentsApi: {
    upload: vi.fn(async (file: File, onProgress: (p: number) => void) => {
      onProgress(100);
      return { document: { id: "doc_1", name: file.name } };
    }),
  },
}));

describe("UploadDropzone", () => {
  it("uploads a picked file and reports it", async () => {
    const onUploaded = vi.fn();
    render(<UploadDropzone onUploaded={onUploaded} />);
    const input = screen.getByLabelText(/choose files/i) as HTMLInputElement;
    const file = new File(["x"], "pick.txt", { type: "text/plain" });
    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() => expect(onUploaded).toHaveBeenCalledWith(expect.objectContaining({ document: expect.objectContaining({ name: "pick.txt" }) })));
  });
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `pnpm --filter @docmind/client test`
Expected: FAIL, cannot find modules.

- [ ] **Step 3: Write the documents API, dropzone, and pages**

`apps/client/src/lib/documents-api.ts`:
```ts
import { api, ApiError } from "./api";

export type DocumentRow = {
  id: string;
  name: string;
  mimeType: string | null;
  sizeBytes: number | null;
  extractionStatus: "pending" | "processing" | "done" | "failed";
  extractionError: string | null;
  createdAt: string;
  updatedAt: string;
};

export type UploadResult = { document: DocumentRow; duplicateOf?: string };

export const documentsApi = {
  async list() {
    return (await api.get<{ documents: DocumentRow[] }>("/api/documents")).documents;
  },
  async get(id: string) {
    return (await api.get<{ document: DocumentRow }>(`/api/documents/${id}`)).document;
  },
  async rename(id: string, name: string) {
    return (await api.json<{ document: DocumentRow }>("PATCH", `/api/documents/${id}`, { name })).document;
  },
  remove(id: string) {
    return api.del(`/api/documents/${id}`);
  },
  fileUrl(id: string, download = false) {
    return `/api/documents/${id}/file${download ? "?download=1" : ""}`;
  },
  upload(file: File, onProgress: (percent: number) => void) {
    return new Promise<UploadResult>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", `/api/documents?name=${encodeURIComponent(file.name)}`);
      xhr.setRequestHeader("content-type", file.type || "application/octet-stream");
      xhr.upload.addEventListener("progress", (e) => {
        if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
      });
      xhr.onload = () => {
        let body: unknown = null;
        try {
          body = JSON.parse(xhr.responseText);
        } catch {
          // no body
        }
        if (xhr.status >= 200 && xhr.status < 300) resolve(body as UploadResult);
        else {
          const err = (body as { error?: { code?: string; message?: string } })?.error;
          reject(new ApiError({ code: err?.code ?? "http_error", message: err?.message ?? "Upload failed", status: xhr.status }));
        }
      };
      xhr.onerror = () => reject(new ApiError({ code: "network", message: "Upload failed", status: 0 }));
      xhr.send(file);
    });
  },
};
```

`apps/client/src/components/documents/UploadDropzone.tsx`:
```tsx
import { useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { documentsApi, type UploadResult } from "@/lib/documents-api";

type Item = { name: string; percent: number; state: "uploading" | "done" | "duplicate" | "failed"; message?: string };

export function UploadDropzone({ onUploaded }: { onUploaded: (result: UploadResult) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [over, setOver] = useState(false);

  function update(index: number, patch: Partial<Item>) {
    setItems((prev) => prev.map((it, i) => (i === index ? { ...it, ...patch } : it)));
  }

  async function uploadAll(files: FileList | File[]) {
    const list = Array.from(files);
    const start = items.length;
    setItems((prev) => [...prev, ...list.map((f) => ({ name: f.name, percent: 0, state: "uploading" as const }))]);
    for (const [i, file] of list.entries()) {
      const index = start + i;
      try {
        const result = await documentsApi.upload(file, (p) => update(index, { percent: p }));
        if (result.duplicateOf) {
          update(index, { state: "duplicate", percent: 100, message: `Already in your library as ${result.document.name}` });
          toast.info(`${file.name} is already in your library as ${result.document.name}`);
        } else {
          update(index, { state: "done", percent: 100 });
        }
        onUploaded(result);
      } catch (error) {
        update(index, { state: "failed", message: (error as Error).message });
        toast.error(`${file.name}: ${(error as Error).message}`);
      }
    }
  }

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        if (e.dataTransfer.files.length) void uploadAll(e.dataTransfer.files);
      }}
      className={`rounded-lg border-2 border-dashed p-6 text-center ${over ? "border-primary bg-muted" : "border-muted-foreground/30"}`}
    >
      <p className="text-sm text-muted-foreground mb-3">Drop files here, or</p>
      <input
        ref={inputRef}
        id="file-picker"
        type="file"
        multiple
        className="sr-only"
        aria-label="Choose files"
        onChange={(e) => {
          if (e.target.files?.length) void uploadAll(e.target.files);
          e.target.value = "";
        }}
      />
      <Button type="button" variant="outline" onClick={() => inputRef.current?.click()}>
        Choose files
      </Button>
      {items.length > 0 && (
        <ul className="mt-4 text-left text-sm space-y-2">
          {items.map((it, i) => (
            <li key={i}>
              <div className="flex justify-between">
                <span className="truncate">{it.name}</span>
                <span className="text-muted-foreground">{it.state === "uploading" ? `${it.percent}%` : it.state}</span>
              </div>
              <div className="h-1 bg-muted rounded">
                <div className={`h-1 rounded ${it.state === "failed" ? "bg-destructive" : "bg-primary"}`} style={{ width: `${it.percent}%` }} />
              </div>
              {it.message && <p className="text-xs text-muted-foreground">{it.message}</p>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
```

`apps/client/src/pages/documents/DocumentsPage.tsx`:
```tsx
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { UploadDropzone } from "@/components/documents/UploadDropzone";
import { documentsApi } from "@/lib/documents-api";
import { formatBytes, formatDate } from "@/lib/format";

export function DocumentsPage() {
  const queryClient = useQueryClient();
  const { data: documents = [], isLoading } = useQuery({ queryKey: ["documents"], queryFn: documentsApi.list });

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">Documents</h1>
      <UploadDropzone onUploaded={() => queryClient.invalidateQueries({ queryKey: ["documents"] })} />
      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading</p>
      ) : documents.length === 0 ? (
        <p className="text-sm text-muted-foreground">No documents yet. Drop a file above to start.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Size</TableHead>
              <TableHead>Added</TableHead>
              <TableHead>Text</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {documents.map((d) => (
              <TableRow key={d.id}>
                <TableCell>
                  <Link to={`/documents/${d.id}`} className="underline-offset-2 hover:underline">
                    {d.name}
                  </Link>
                </TableCell>
                <TableCell className="text-muted-foreground">{d.mimeType ?? "unknown"}</TableCell>
                <TableCell>{d.sizeBytes == null ? "" : formatBytes(d.sizeBytes)}</TableCell>
                <TableCell>{formatDate(d.createdAt)}</TableCell>
                <TableCell>
                  <Badge variant={d.extractionStatus === "failed" ? "destructive" : "secondary"}>{d.extractionStatus}</Badge>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
```

`apps/client/src/pages/documents/DocumentDetailPage.tsx`:
```tsx
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { documentsApi } from "@/lib/documents-api";
import { formatBytes, formatDate } from "@/lib/format";

function Preview({ id, mimeType }: { id: string; mimeType: string | null }) {
  const url = documentsApi.fileUrl(id);
  if (mimeType === "application/pdf") return <iframe title="Preview" src={url} className="w-full h-[70vh] border rounded" />;
  if (mimeType?.startsWith("image/")) return <img src={url} alt="Preview" className="max-h-[70vh] rounded border" />;
  return (
    <p className="text-sm text-muted-foreground">
      No inline preview for this type.{" "}
      <a className="underline" href={documentsApi.fileUrl(id, true)}>
        Download
      </a>
    </p>
  );
}

export function DocumentDetailPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: document } = useQuery({ queryKey: ["documents", id], queryFn: () => documentsApi.get(id) });
  const [renameOpen, setRenameOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [name, setName] = useState("");

  const rename = useMutation({
    mutationFn: () => documentsApi.rename(id, name),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["documents"] });
      setRenameOpen(false);
      toast.success("Renamed");
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const remove = useMutation({
    mutationFn: () => documentsApi.remove(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["documents"] });
      navigate("/documents");
      toast.success("Deleted");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (!document) return null;

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold break-all">{document.name}</h1>
          <p className="text-sm text-muted-foreground">
            {document.mimeType ?? "unknown type"} · {document.sizeBytes == null ? "" : formatBytes(document.sizeBytes)} · added {formatDate(document.createdAt)}
          </p>
        </div>
        <div className="flex gap-2">
          <Button asChild variant="outline">
            <a href={documentsApi.fileUrl(id, true)}>Download</a>
          </Button>
          <Button
            variant="outline"
            onClick={() => {
              setName(document.name);
              setRenameOpen(true);
            }}
          >
            Rename
          </Button>
          <Button variant="destructive" onClick={() => setDeleteOpen(true)}>
            Delete
          </Button>
        </div>
      </div>

      <Preview id={id} mimeType={document.mimeType} />

      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename document</DialogTitle>
          </DialogHeader>
          <Input value={name} onChange={(e) => setName(e.target.value)} />
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameOpen(false)}>
              Cancel
            </Button>
            <Button onClick={() => rename.mutate()} disabled={rename.isPending || !name.trim()}>
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete this document?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">The file is removed from storage. This cannot be undone.</p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteOpen(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={() => remove.mutate()} disabled={remove.isPending}>
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `pnpm --filter @docmind/client test && pnpm --filter @docmind/client typecheck`
Expected: PASS, 5 tests; typecheck clean.

- [ ] **Step 5: Smoke the flow by hand**

With both dev servers running: drop a PDF, an image, and a text file. Expected: three rows appear, each shows `pending` for text. Open the PDF: it renders in the frame. Drop the same PDF again: a toast says it is already in the library and no new row appears. Rename one, delete one.

- [ ] **Step 6: Commit**

```bash
git add apps/client
git commit -m "feat(client): add documents library with streamed upload, preview, rename, and delete"
```

---

### Task 14: Running locally docs and milestone wrap-up

**Files:**
- Modify: `CLAUDE.md` (the "Running locally" section)
- Modify: `apps/server/.env.example` if any variable changed during the milestone
- Modify: `.gitignore` (add `apps/server/documents/` if the default root sits there)

**Interfaces:** none. This task records what the milestone produced so the next session can start cold.

- [ ] **Step 1: Replace the "Running locally" section in CLAUDE.md**

```markdown
## Running locally

Node 22 and pnpm: `nvm use 22 && corepack enable`.

    pnpm install
    cp apps/server/.env.example apps/server/.env
    # fill SETTINGS_ENCRYPTION_KEY (openssl rand -hex 32) and AUTH_SECRET (openssl rand -hex 48)
    pnpm --filter @docmind/server db:migrate
    pnpm dev              # server on :4000, client on :5173, client proxies /api

Tests and typecheck: `pnpm test` and `pnpm typecheck` from the root, or per app with
`pnpm --filter @docmind/server test` and `pnpm --filter @docmind/client test`.

After changing any `*.tables.ts`: `cd apps/server && pnpm db:generate --name <change>`,
then commit the new files under `apps/server/drizzle/`.

First run: open http://localhost:5173, create the single account. Sign up closes after it.
```

- [ ] **Step 2: Run the full suite one last time**

Run: `pnpm test && pnpm typecheck`
Expected: all green in both apps.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md apps/server/.env.example .gitignore
git commit -m "docs: record how to run DocMind locally after milestone A"
```

Milestone A is complete when: the full suite passes, the manual smoke in Task 13 works, and `pnpm build` succeeds in both apps.
