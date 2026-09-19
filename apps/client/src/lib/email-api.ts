import { api } from "./api";

export type EmailTestResult = { ok: boolean; message: string };

export const emailApi = {
  async test() {
    return api.json<EmailTestResult>("POST", "/api/email/test", {});
  },
};
