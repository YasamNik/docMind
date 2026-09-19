import { api } from "./api";

export type SearchResult = {
  documentId: string;
  documentName: string;
  chunkText: string;
  chunkIndex: number;
  score: number;
  source: "vector" | "keyword" | "hybrid";
  storageDriver: string;
};

export const searchApi = {
  async search(query: string, limit = 20) {
    return api.get<{ results: SearchResult[]; query: string }>(`/api/search?q=${encodeURIComponent(query)}&limit=${limit}`);
  },
  async reembedAll() {
    return api.json<{ count: number; jobIds: string[] }>("POST", "/api/search/reembed-all", {});
  },
};
