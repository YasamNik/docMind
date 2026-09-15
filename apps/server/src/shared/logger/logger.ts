import pino from "pino";

const root = pino({
  level: process.env.LOG_LEVEL ?? "info",
  redact: ["*.apiKey", "*.secret", "*.password", "*.token", "*.authorization"],
});

export function createLogger(namespace: string) {
  return root.child({ namespace });
}

export type Logger = ReturnType<typeof createLogger>;
