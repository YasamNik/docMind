import { api } from "./api";

export type ChatSession = {
  id: string;
  title: string | null;
  documentScope: string[] | null;
  createdAt: string;
  updatedAt: string;
};

export type Citation = {
  documentId: string;
  documentName: string;
  chunkText: string;
  chunkIndex: number;
  storageDriver: string;
};

export type ChatMessage = {
  id: string;
  sessionId: string;
  role: string;
  content: string;
  citations: Citation[] | null;
  error: string | null;
  createdAt: string;
};

export const chatApi = {
  async createSession(documentScope?: string[]) {
    return (await api.json<{ session: ChatSession }>("POST", "/api/chat/sessions", { documentScope })).session;
  },
  async listSessions() {
    return (await api.get<{ sessions: ChatSession[] }>("/api/chat/sessions")).sessions;
  },
  async getSession(id: string) {
    return api.get<{ session: ChatSession; messages: ChatMessage[] }>(`/api/chat/sessions/${id}`);
  },
  deleteSession(id: string) {
    return api.del(`/api/chat/sessions/${id}`);
  },
};
