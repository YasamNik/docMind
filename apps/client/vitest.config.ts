import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
    setupFiles: ["./src/test-setup.ts"],
    // Room above the five second `waitFor` ceiling in test-setup.ts, so a slow query fails
    // with Testing Library's "unable to find element" message instead of a bare timeout.
    testTimeout: 15000,
  },
});
