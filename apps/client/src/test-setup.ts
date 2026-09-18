import { configure } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

// Testing Library defaults `waitFor` to one second. That is enough on an idle machine but
// not when the server and client suites run at once and each sizes its worker pool to the
// full CPU count, which starves the jsdom workers and fails queries for elements that do
// arrive. A longer ceiling only costs time on a query that was going to fail anyway.
configure({ asyncUtilTimeout: 5000 });
