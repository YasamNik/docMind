CREATE TABLE `document_types` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`color` text,
	`confidence_threshold` real DEFAULT 0.7 NOT NULL,
	`auto_apply` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `document_types_user_idx` ON `document_types` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `document_types_user_name_idx` ON `document_types` (`user_id`,"name" COLLATE NOCASE);--> statement-breakpoint
ALTER TABLE `documents` ADD `document_type_id` text;--> statement-breakpoint
ALTER TABLE `documents` ADD `document_type_source` text;