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
