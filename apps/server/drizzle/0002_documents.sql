CREATE TABLE `documents` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`mime_type` text,
	`size_bytes` integer,
	`content_hash` text,
	`storage_driver` text NOT NULL,
	`storage_key` text NOT NULL,
	`extracted_text` text,
	`extraction_status` text DEFAULT 'pending' NOT NULL,
	`extraction_error` text,
	`rule_status` text DEFAULT 'pending' NOT NULL,
	`rule_error` text,
	`embedding_status` text DEFAULT 'pending' NOT NULL,
	`embedding_error` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
