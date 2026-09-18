import { sql } from "drizzle-orm";
import { index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { documentsTable } from "../documents/documents.tables.js";

export const categoriesTable = sqliteTable(
  "categories",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    name: text("name").notNull(),
    parentId: text("parent_id"),
    color: text("color"),
    description: text("description").notNull().default(""),
    confidenceThreshold: real("confidence_threshold").notNull().default(0.7),
    autoApply: integer("auto_apply").notNull().default(1),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    index("categories_user_parent_idx").on(t.userId, t.parentId),
    uniqueIndex("categories_user_parent_name_idx").on(t.userId, t.parentId, sql`${t.name} COLLATE NOCASE`),
    // SQLite treats every NULL as distinct for uniqueness, so the index above does not
    // stop two root categories (parent_id NULL) from sharing a name. A second, partial
    // unique index covers exactly that case. Confirmed empirically during planning:
    // without this index, inserting "Finance" and "finance" both at the root succeeds.
    uniqueIndex("categories_user_root_name_idx")
      .on(t.userId, sql`${t.name} COLLATE NOCASE`)
      .where(sql`${t.parentId} is null`),
  ],
);

export const tagsTable = sqliteTable(
  "tags",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    name: text("name").notNull(),
    color: text("color"),
    description: text("description").notNull().default(""),
    confidenceThreshold: real("confidence_threshold").notNull().default(0.7),
    autoApply: integer("auto_apply").notNull().default(1),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [index("tags_user_idx").on(t.userId), uniqueIndex("tags_user_name_idx").on(t.userId, sql`${t.name} COLLATE NOCASE`)],
);

export const documentTypesTable = sqliteTable(
  "document_types",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    color: text("color"),
    confidenceThreshold: real("confidence_threshold").notNull().default(0.7),
    autoApply: integer("auto_apply").notNull().default(1),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    index("document_types_user_idx").on(t.userId),
    uniqueIndex("document_types_user_name_idx").on(t.userId, sql`${t.name} COLLATE NOCASE`),
  ],
);

export const documentTagsTable = sqliteTable(
  "document_tags",
  {
    documentId: text("document_id")
      .notNull()
      .references(() => documentsTable.id, { onDelete: "cascade" }),
    tagId: text("tag_id")
      .notNull()
      .references(() => tagsTable.id, { onDelete: "cascade" }),
    appliedByManual: integer("applied_by_manual").notNull().default(0),
    appliedByAuto: integer("applied_by_auto").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.documentId, t.tagId] }), index("document_tags_tag_idx").on(t.tagId)],
);
