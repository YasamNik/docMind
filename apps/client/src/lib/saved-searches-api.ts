import { api } from "./api";

export type SavedSearch = {
  id: string;
  userId: string;
  name: string;
  query: string;
  filters: string;
  createdAt: string;
  updatedAt: string;
};

export const savedSearchesApi = {
  async list() {
    return (await api.get<{ searches: SavedSearch[] }>("/api/saved-searches")).searches;
  },
  async create(name: string, query: string, filters: Record<string, unknown> = {}) {
    return (await api.json<{ search: SavedSearch }>("POST", "/api/saved-searches", { name, query, filters })).search;
  },
  async update(id: string, patch: { name?: string; query?: string; filters?: Record<string, unknown> }) {
    return (await api.json<{ search: SavedSearch }>("PATCH", `/api/saved-searches/${id}`, patch)).search;
  },
  async remove(id: string) {
    return api.del(`/api/saved-searches/${id}`);
  },
};
