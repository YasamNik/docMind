import { api } from "./api";

export type DescriptionAssistantInput = {
  targetType: "tag" | "category";
  name: string;
  description: string;
};

export const descriptionAssistantApi = {
  suggest(input: DescriptionAssistantInput) {
    return api.json<{ suggestion: string }>("POST", "/api/tags/description-assistant", input);
  },
};
