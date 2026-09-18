import { api, ApiError } from "./api";
import type { TagChip } from "./tags-api";

export type DocumentRow = {
  id: string;
  name: string;
  mimeType: string | null;
  sizeBytes: number | null;
  extractionStatus: "pending" | "processing" | "done" | "failed";
  extractionError: string | null;
  categoryId: string | null;
  categoryPath: string | null;
  tags: TagChip[];
  summary: string | null;
  suggestedTitle: string | null;
  summaryStatus: "pending" | "processing" | "done" | "failed";
  summaryError: string | null;
  documentDate: string | null;
  triageStatus: "pending" | "reviewed";
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type EvaluationRow = {
  id: string;
  targetType: "tag" | "category";
  targetId: string;
  itemName: string;
  matched: number;
  confidence: number | null;
  reasoning: string | null;
  outcome: string;
  proposalKind: string | null;
  evaluatedAt: string;
};

export type DocumentDetail = DocumentRow & { extractedText: string | null; categorySource: "manual" | "auto" | null };

export type UploadResult = { document: DocumentDetail; duplicateOf?: string };

export type DocumentListFilters = { categoryId?: string; tagId?: string; view?: "inbox" | "needs_review" | "all" | "trash" };

export const documentsApi = {
  async list(filters: DocumentListFilters = {}) {
    const params = new URLSearchParams();
    if (filters.categoryId) params.set("categoryId", filters.categoryId);
    if (filters.tagId) params.set("tagId", filters.tagId);
    if (filters.view && filters.view !== "all") params.set("view", filters.view);
    const qs = params.toString();
    return (await api.get<{ documents: DocumentRow[] }>(`/api/documents${qs ? `?${qs}` : ""}`)).documents;
  },
  async counts() {
    return api.get<{ inbox: number; needsReview: number; trash: number }>("/api/documents/counts");
  },
  async get(id: string) {
    return (await api.get<{ document: DocumentDetail }>(`/api/documents/${id}`)).document;
  },
  async rename(id: string, name: string) {
    return (await api.json<{ document: DocumentDetail }>("PATCH", `/api/documents/${id}`, { name })).document;
  },
  remove(id: string) {
    return api.del(`/api/documents/${id}`);
  },
  async reextract(id: string) {
    return (await api.json<{ job: { id: string; status: string } }>("POST", `/api/documents/${id}/extract`, {})).job;
  },
  async acceptTitle(id: string) {
    return (await api.json<{ document: DocumentDetail }>("POST", `/api/documents/${id}/accept-title`, {})).document;
  },
  fileUrl(id: string, download = false) {
    return `/api/documents/${id}/file${download ? "?download=1" : ""}`;
  },
  async bulkDelete(documentIds: string[]) {
    return api.json<{ count: number }>("POST", "/api/documents/bulk/delete", { documentIds });
  },
  async bulkTag(documentIds: string[], tagId: string, action: "add" | "remove") {
    return api.json<{ count: number }>("POST", "/api/documents/bulk/tag", { documentIds, tagId, action });
  },
  async bulkCategory(documentIds: string[], categoryId: string | null) {
    return api.json<{ count: number }>("POST", "/api/documents/bulk/category", { documentIds, categoryId });
  },
  async bulkSort(documentIds: string[]) {
    return api.json<{ count: number; jobIds: string[] }>("POST", "/api/documents/bulk/sort", { documentIds });
  },
  async restore(id: string) {
    return (await api.json<{ document: DocumentDetail }>("POST", `/api/documents/${id}/restore`, {})).document;
  },
  async purge(id: string) {
    return api.del(`/api/documents/${id}/permanent`);
  },
  async acceptTriage(id: string, acceptTitle = false) {
    return (await api.json<{ document: DocumentDetail }>("POST", `/api/documents/${id}/triage`, { action: "accept", acceptTitle })).document;
  },
  async acceptTriageBatch(documentIds: string[]) {
    return api.json<{ updatedCount: number }>("POST", "/api/documents/triage", { documentIds, action: "accept" });
  },
  async listEvaluations(id: string) {
    return (await api.get<{ evaluations: EvaluationRow[] }>(`/api/documents/${id}/evaluations`)).evaluations;
  },
  upload(file: File, onProgress: (percent: number) => void) {
    return new Promise<UploadResult>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", `/api/documents?name=${encodeURIComponent(file.name)}`);
      xhr.withCredentials = true;
      xhr.setRequestHeader("content-type", file.type || "application/octet-stream");
      xhr.upload.addEventListener("progress", (e) => {
        if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
      });
      xhr.onload = () => {
        let body: unknown = null;
        try {
          body = JSON.parse(xhr.responseText);
        } catch {
          // no body
        }
        if (xhr.status >= 200 && xhr.status < 300) resolve(body as UploadResult);
        else {
          const err = (body as { error?: { code?: string; message?: string } })?.error;
          reject(new ApiError({ code: err?.code ?? "http_error", message: err?.message ?? "Upload failed", status: xhr.status }));
        }
      };
      xhr.onerror = () => reject(new ApiError({ code: "network", message: "Upload failed", status: 0 }));
      xhr.send(file);
    });
  },
};
