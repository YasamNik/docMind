import { api } from "./api";
import type { SetupGuide } from "@/pages/settings/ProviderCard";

export type StorageDriverSummary = {
  id: string;
  label: string;
  guide: SetupGuide;
  configured: boolean;
  documentCount: number;
  active: boolean;
};

export type StorageTestResult = { ok: boolean; message: string };

export const storageApi = {
  async list() {
    return (await api.get<{ drivers: StorageDriverSummary[] }>("/api/storage/drivers")).drivers;
  },
  async test(id: string) {
    return api.json<StorageTestResult>("POST", `/api/storage/drivers/${id}/test`, {});
  },
};
