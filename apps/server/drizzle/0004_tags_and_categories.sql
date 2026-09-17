CREATE TABLE `categories` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`parent_id` text,
	`color` text,
	`description` text DEFAULT '' NOT NULL,
	`confidence_threshold` real DEFAULT 0.7 NOT NULL,
	`auto_apply` integer DEFAULT 1 NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `categories_user_parent_idx` ON `categories` (`user_id`,`parent_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `categories_user_parent_name_idx` ON `categories` (`user_id`,`parent_id`,"name" COLLATE NOCASE);--> statement-breakpoint
CREATE UNIQUE INDEX `categories_user_root_name_idx` ON `categories` (`user_id`,"name" COLLATE NOCASE) WHERE "categories"."parent_id" is null;--> statement-breakpoint
CREATE TABLE `document_tags` (
	`document_id` text NOT NULL,
	`tag_id` text NOT NULL,
	`applied_by_manual` integer DEFAULT 0 NOT NULL,
	`applied_by_auto` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`document_id`, `tag_id`),
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tag_id`) REFERENCES `tags`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `document_tags_tag_idx` ON `document_tags` (`tag_id`);--> statement-breakpoint
CREATE TABLE `tags` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`color` text,
	`description` text DEFAULT '' NOT NULL,
	`confidence_threshold` real DEFAULT 0.7 NOT NULL,
	`auto_apply` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `tags_user_idx` ON `tags` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `tags_user_name_idx` ON `tags` (`user_id`,"name" COLLATE NOCASE);--> statement-breakpoint
ALTER TABLE `documents` ADD `category_id` text;--> statement-breakpoint
ALTER TABLE `documents` ADD `category_source` text;--> statement-breakpoint
CREATE INDEX `documents_user_category_idx` ON `documents` (`user_id`,`category_id`);