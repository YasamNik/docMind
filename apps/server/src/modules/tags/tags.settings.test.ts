import { describe, expect, it } from "vitest";
import { allSettingDefinitions } from "../settings/settings.definitions.js";
import { tagsSettingDefinitions } from "./tags.settings.js";

describe("tags settings", () => {
  it("defines the preset-seeding guard flag as internal with a false default", () => {
    const keys = tagsSettingDefinitions.map((d) => d.key);
    expect(keys).toEqual(["types.presetsSeeded"]);
    expect(tagsSettingDefinitions[0]).toMatchObject({ default: false, secret: false, internal: true });
  });

  it("is registered in the global definitions", () => {
    const keys = allSettingDefinitions.map((d) => d.key);
    expect(keys).toContain("types.presetsSeeded");
  });
});
