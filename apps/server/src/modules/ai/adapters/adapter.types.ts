export type AdapterConfig = {
  apiKey: string;
  baseUrl: string;
  providerId: string;
  isOpenRouter?: boolean;
  // Whether the provider exposes a models list endpoint. Defaults to true.
  // When false, testConnection verifies the connection with a one-token chat
  // completion instead of listing models.
  listModels?: boolean;
};

export type { AiAdapter } from "../ai.types.js";
