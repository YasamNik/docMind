CREATE TABLE `document_fields` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`document_id` text NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	`value_number` real,
	`value_date` text,
	`currency` text,
	`confidence` real,
	`source` text DEFAULT 'llm' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `document_fields_document_key_idx` ON `document_fields` (`document_id`,`key`);--> statement-breakpoint
CREATE INDEX `document_fields_user_key_idx` ON `document_fields` (`user_id`,`key`);