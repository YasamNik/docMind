import { api, ApiError } from "./api";

export type DocumentRow = {
  id: string;
  name: string;
  mimeType: string | null;
  sizeBytes: number | null;
  extractionStatus: "pending" | "processing" | "done" | "failed";
  extractionError: string | null;
  createdAt: string;
  updatedAt: string;
};

export type DocumentDetail = DocumentRow & { extractedText: string | null };

export type UploadResult = { document: DocumentDetail; duplicateOf?: string };

export const documentsApi = {
  async list() {
    return (await api.get<{ documents: DocumentRow[] }>("/api/documents")).documents;
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
  fileUrl(id: string, download = false) {
    return `/api/documents/${id}/file${download ? "?download=1" : ""}`;
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
