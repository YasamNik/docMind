CREATE TABLE `budget_categories` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`color` text,
	`auto_apply` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `budget_categories_user_idx` ON `budget_categories` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `budget_categories_user_name_idx` ON `budget_categories` (`user_id`,"name" COLLATE NOCASE);--> statement-breakpoint
CREATE TABLE `budget_receipt_items` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`receipt_id` text NOT NULL,
	`line_number` integer NOT NULL,
	`description` text NOT NULL,
	`quantity` real,
	`unit_price` real,
	`amount` real NOT NULL,
	`category_id` text,
	`category_source` text,
	`confidence` real,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`receipt_id`) REFERENCES `budget_receipts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`category_id`) REFERENCES `budget_categories`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `budget_receipt_items_receipt_line_idx` ON `budget_receipt_items` (`receipt_id`,`line_number`);--> statement-breakpoint
CREATE TABLE `budget_receipts` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`document_id` text NOT NULL,
	`merchant` text,
	`category_id` text,
	`purchased_at` text,
	`currency` text,
	`total` real,
	`tax_amount` real,
	`status` text DEFAULT 'pending' NOT NULL,
	`note` text,
	`duplicate_of_receipt_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`category_id`) REFERENCES `budget_categories`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`duplicate_of_receipt_id`) REFERENCES `budget_receipts`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `budget_receipts_user_purchased_idx` ON `budget_receipts` (`user_id`,`purchased_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `budget_receipts_user_document_idx` ON `budget_receipts` (`user_id`,`document_id`);