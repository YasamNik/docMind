import { expect } from "vitest";
import { isAppError } from "../errors/errors.js";

export async function expectAppError(run: () => unknown, code: string) {
  try {
    await run();
  } catch (error) {
    expect(isAppError(error), `expected AppError, got ${String(error)}`).toBe(true);
    expect((error as { code: string }).code).toBe(code);
    return;
  }
  expect.fail(`expected an AppError with code "${code}" but nothing was thrown`);
}
