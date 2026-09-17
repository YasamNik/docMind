CREATE TABLE `sort_evaluations` (
	`id` text PRIMARY KEY NOT NULL,
	`document_id` text NOT NULL,
	`target_type` text NOT NULL,
	`target_id` text NOT NULL,
	`matched` integer NOT NULL,
	`confidence` real NOT NULL,
	`reasoning` text NOT NULL,
	`outcome` text NOT NULL,
	`proposal_kind` text,
	`model_id` text NOT NULL,
	`job_id` text NOT NULL,
	`content_hash` text,
	`evaluated_at` text NOT NULL,
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `sort_evaluations_document_evaluated_idx` ON `sort_evaluations` (`document_id`,`evaluated_at`);--> statement-breakpoint
CREATE INDEX `sort_evaluations_target_idx` ON `sort_evaluations` (`target_type`,`target_id`);--> statement-breakpoint
CREATE INDEX `sort_evaluations_outcome_document_idx` ON `sort_evaluations` (`outcome`,`document_id`);