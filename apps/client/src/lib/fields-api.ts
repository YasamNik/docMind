import { api } from "./api";

export const fieldsApi = {
  async values(key: string) {
    return (await api.get<{ values: string[] }>(`/api/fields/values?key=${encodeURIComponent(key)}`)).values;
  },
  async backfill() {
    return api.json<{ enqueued: number; skipped: number }>("POST", "/api/fields/backfill", {});
  },
};
