import { describe, expect, it } from "vitest";
import { allSettingDefinitions } from "../settings/settings.definitions.js";
import { extractionSettingDefinitions } from "./extraction.settings.js";

describe("extraction settings", () => {
  it("defines OCR languages and data dir with defaults and env seeds", () => {
    const keys = extractionSettingDefinitions.map((d) => d.key);
    expect(keys).toEqual(["extraction.ocrLanguages", "extraction.dataDir"]);
    expect(extractionSettingDefinitions[0]).toMatchObject({ env: "OCR_LANGUAGES", default: "eng", secret: false });
    expect(extractionSettingDefinitions[1]).toMatchObject({ env: "DATA_DIR", default: "./data" });
  });

  it("is registered in the global definitions", () => {
    const keys = allSettingDefinitions.map((d) => d.key);
    expect(keys).toContain("extraction.ocrLanguages");
    expect(keys).toContain("extraction.dataDir");
  });
});
