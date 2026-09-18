import { api } from "./api";

export type DocumentTypeRow = {
  id: string;
  name: string;
  color: string | null;
  description: string;
  confidenceThreshold: number;
  autoApply: boolean;
  documentCount: number;
  createdAt: string;
  updatedAt: string;
};

export type DocumentTypeInput = {
  name: string;
  color?: string | null;
  description?: string;
  confidenceThreshold?: number;
  autoApply?: boolean;
};

export const typesApi = {
  async list() {
    return (await api.get<{ types: DocumentTypeRow[] }>("/api/types")).types;
  },
  async create(input: DocumentTypeInput) {
    return (await api.json<{ type: DocumentTypeRow }>("POST", "/api/types", input)).type;
  },
  async update(id: string, patch: Partial<DocumentTypeInput>) {
    return (await api.json<{ type: DocumentTypeRow }>("PATCH", `/api/types/${id}`, patch)).type;
  },
  remove(id: string) {
    return api.del(`/api/types/${id}`);
  },
};

export const documentTypeApi = {
  async setType(documentId: string, documentTypeId: string | null) {
    return (await api.json<{ document: unknown }>("PUT", `/api/documents/${documentId}/type`, { documentTypeId })).document;
  },
};
