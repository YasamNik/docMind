import { afterEach, describe, expect, it, vi } from "vitest";
import { settingsApi } from "./settings-api";

afterEach(() => vi.restoreAllMocks());

describe("settingsApi", () => {
  it("lists settings", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ settings: [{ key: "test", value: "ok" }] }), { status: 200 }),
    );
    const result = await settingsApi.list();
    expect(result).toEqual([{ key: "test", value: "ok" }]);
  });

  it("updates settings", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ settings: [{ key: "test", value: "new" }] }), { status: 200 }),
    );
    const result = await settingsApi.update({ test: "new" });
    expect(result).toEqual([{ key: "test", value: "new" }]);
    expect((spy.mock.calls[0]?.[1] as RequestInit).method).toBe("PUT");
  });
});
