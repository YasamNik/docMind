import { api } from "./api";

export type JobRow = {
  id: string;
  type: string;
  status: "pending" | "processing" | "done" | "failed";
  attempts: number;
  error: string | null;
  payload: { documentId?: string; [key: string]: unknown };
  createdAt: string;
  startedAt?: string | null;
  finishedAt?: string | null;
};

export const jobsApi = {
  async list(status?: JobRow["status"]) {
    const path = status ? `/api/jobs?status=${encodeURIComponent(status)}` : "/api/jobs";
    return (await api.get<{ jobs: JobRow[] }>(path)).jobs;
  },
  async retry(id: string) {
    return (await api.json<{ job: JobRow }>("POST", `/api/jobs/${id}/retry`, {})).job;
  },
};
