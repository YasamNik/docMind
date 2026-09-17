import * as v from "valibot";
import { describe, expect, it } from "vitest";
import {
  categoryDescriptionSchema,
  categoryIdSchema,
  colorSchema,
  createCategoryBodySchema,
  nameSchema,
  tagDescriptionSchema,
  tagIdSchema,
  thresholdSchema,
  updateCategoryBodySchema,
} from "./tags.schemas.js";

describe("tags schemas", () => {
  it("accepts a name at the 60 character limit and rejects one past it", () => {
    expect(v.safeParse(nameSchema, "a".repeat(60)).success).toBe(true);
    expect(v.safeParse(nameSchema, "a".repeat(61)).success).toBe(false);
  });

  it("accepts a hex color and rejects a malformed one", () => {
    expect(v.safeParse(colorSchema, "#4f46e5").success).toBe(true);
    expect(v.safeParse(colorSchema, "#4F46E5").success).toBe(true);
    expect(v.safeParse(colorSchema, "4f46e5").success).toBe(false);
    expect(v.safeParse(colorSchema, "#4f46e").success).toBe(false);
    expect(v.safeParse(colorSchema, "#zzzzzz").success).toBe(false);
  });

  it("accepts a tag description at the 300 character limit and rejects one past it", () => {
    expect(v.safeParse(tagDescriptionSchema, "a".repeat(300)).success).toBe(true);
    expect(v.safeParse(tagDescriptionSchema, "a".repeat(301)).success).toBe(false);
  });

  it("accepts a category description at the 2000 character limit and rejects one past it", () => {
    expect(v.safeParse(categoryDescriptionSchema, "a".repeat(2000)).success).toBe(true);
    expect(v.safeParse(categoryDescriptionSchema, "a".repeat(2001)).success).toBe(false);
  });

  it("accepts a confidence threshold at 0 and 1 and rejects outside that range", () => {
    expect(v.safeParse(thresholdSchema, 0).success).toBe(true);
    expect(v.safeParse(thresholdSchema, 1).success).toBe(true);
    expect(v.safeParse(thresholdSchema, -0.01).success).toBe(false);
    expect(v.safeParse(thresholdSchema, 1.01).success).toBe(false);
  });

  it("accepts a well-formed tag id and rejects a malformed one", () => {
    expect(v.safeParse(tagIdSchema, "tag_0123456789abcdef").success).toBe(true);
    expect(v.safeParse(tagIdSchema, "tag_123").success).toBe(false);
    expect(v.safeParse(tagIdSchema, "cat_0123456789abcdef").success).toBe(false);
  });

  it("accepts a well-formed category id and rejects a malformed one", () => {
    expect(v.safeParse(categoryIdSchema, "cat_0123456789abcdef").success).toBe(true);
    expect(v.safeParse(categoryIdSchema, "cat_123").success).toBe(false);
    expect(v.safeParse(categoryIdSchema, "tag_0123456789abcdef").success).toBe(false);
  });

  it("rejects a malformed parentId in the create and update category body schemas", () => {
    expect(v.safeParse(createCategoryBodySchema, { name: "Tax", parentId: "not-an-id" }).success).toBe(false);
    expect(v.safeParse(updateCategoryBodySchema, { parentId: "not-an-id" }).success).toBe(false);
  });
});
