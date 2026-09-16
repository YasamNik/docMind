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
