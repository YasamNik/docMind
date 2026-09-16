import { api } from "./api";

export type ResolvedSetting = {
  key: string;
  value: unknown;
  source: "db" | "env" | "default" | "unset";
  secret: boolean;
  doc: string;
};

export const settingsApi = {
  async list() {
    return (await api.get<{ settings: ResolvedSetting[] }>("/api/settings")).settings;
  },
  async update(updates: Record<string, unknown>) {
    return (await api.json<{ settings: ResolvedSetting[] }>("PUT", "/api/settings", { updates })).settings;
  },
};
