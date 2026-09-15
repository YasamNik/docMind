import * as v from "valibot";

export function requiredMessage(name: string, bytes: number): string {
  return `${name} is required. Generate one with: openssl rand -hex ${bytes}`;
}

export const hexKeySchema = (bytes: number, name: string) =>
  v.pipe(
    v.string(),
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
