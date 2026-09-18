CREATE TABLE `rule_examples` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`target_type` text NOT NULL,
	`target_id` text NOT NULL,
	`document_id` text NOT NULL,
	`document_snippet` text NOT NULL,
	`signal` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `rule_examples_target_idx` ON `rule_examples` (`target_type`,`target_id`);