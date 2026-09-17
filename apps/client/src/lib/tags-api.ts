import { api } from "./api";

export type TagChip = { id: string; name: string; color: string | null; auto: boolean; manual: boolean };

export type TagRow = {
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

export type CategoryRow = {
  id: string;
  name: string;
  parentId: string | null;
  color: string | null;
  description: string;
  confidenceThreshold: number;
  autoApply: boolean;
  sortOrder: number;
  path: string;
  documentCount: number;
  createdAt: string;
  updatedAt: string;
};

export type TagInput = {
  name: string;
  color?: string | null;
  description?: string;
  confidenceThreshold?: number;
  autoApply?: boolean;
};

export type CategoryInput = TagInput & { parentId?: string | null; sortOrder?: number };

export const tagsApi = {
  async list() {
    return (await api.get<{ tags: TagRow[] }>("/api/tags")).tags;
  },
  async create(input: TagInput) {
    return (await api.json<{ tag: TagRow }>("POST", "/api/tags", input)).tag;
  },
  async update(id: string, patch: Partial<TagInput>) {
    return (await api.json<{ tag: TagRow }>("PATCH", `/api/tags/${id}`, patch)).tag;
  },
  remove(id: string) {
    return api.del(`/api/tags/${id}`);
  },
};

export const categoriesApi = {
  async list() {
    return (await api.get<{ categories: CategoryRow[] }>("/api/categories")).categories;
  },
  async create(input: CategoryInput) {
    return (await api.json<{ category: CategoryRow }>("POST", "/api/categories", input)).category;
  },
  async update(id: string, patch: Partial<CategoryInput>) {
    return (await api.json<{ category: CategoryRow }>("PATCH", `/api/categories/${id}`, patch)).category;
  },
  remove(id: string) {
    return api.del(`/api/categories/${id}`);
  },
};

export const documentCategorizationApi = {
  async setCategory(documentId: string, categoryId: string | null) {
    return (await api.json<{ document: unknown }>("PUT", `/api/documents/${documentId}/category`, { categoryId })).document;
  },
  addTag(documentId: string, tagId: string) {
    return api.json<{ tags: TagChip[] }>("POST", `/api/documents/${documentId}/tags/${tagId}`, {}).then((r) => r.tags);
  },
  removeTag(documentId: string, tagId: string) {
    return api.del<{ tags: TagChip[] }>(`/api/documents/${documentId}/tags/${tagId}`).then((r) => r.tags);
  },
};
