import type { categoriesTable, documentTagsTable, tagsTable } from "./tags.tables.js";

export type Category = typeof categoriesTable.$inferSelect;
export type NewCategory = typeof categoriesTable.$inferInsert;
export type Tag = typeof tagsTable.$inferSelect;
export type NewTag = typeof tagsTable.$inferInsert;
export type DocumentTag = typeof documentTagsTable.$inferSelect;
export type NewDocumentTag = typeof documentTagsTable.$inferInsert;

export type TagChip = { id: string; name: string; color: string | null; auto: boolean; manual: boolean };

export type TagWithCount = Omit<Tag, "autoApply"> & { autoApply: boolean; documentCount: number };
export type CategoryWithMeta = Omit<Category, "autoApply"> & { autoApply: boolean; path: string; documentCount: number };
