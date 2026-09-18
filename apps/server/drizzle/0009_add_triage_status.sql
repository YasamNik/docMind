ALTER TABLE `documents` ADD `triage_status` text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
UPDATE `documents` SET `triage_status` = 'reviewed';--> statement-breakpoint
CREATE INDEX `documents_user_triage_idx` ON `documents` (`user_id`,`triage_status`);