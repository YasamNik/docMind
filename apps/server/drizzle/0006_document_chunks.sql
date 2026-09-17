CREATE TABLE `document_chunks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`document_id` text NOT NULL,
	`chunk_index` integer NOT NULL,
	`chunk_text` text NOT NULL,
	`token_count` integer NOT NULL,
	`start_char` integer NOT NULL,
	`end_char` integer NOT NULL,
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `document_chunks_document_chunk_idx` ON `document_chunks` (`document_id`,`chunk_index`);--> statement-breakpoint
ALTER TABLE `documents` ADD `summary` text;--> statement-breakpoint
ALTER TABLE `documents` ADD `suggested_title` text;--> statement-breakpoint
ALTER TABLE `documents` ADD `summary_status` text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE `documents` ADD `summary_error` text;--> statement-breakpoint
CREATE VIRTUAL TABLE IF NOT EXISTS `document_chunks_fts` USING fts5(
  chunk_text,
  content=`document_chunks`,
  content_rowid=`id`
);--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS document_chunks_fts_ai AFTER INSERT ON `document_chunks` BEGIN
  INSERT INTO `document_chunks_fts`(`rowid`, `chunk_text`) VALUES (new.`id`, new.`chunk_text`);
END;--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS document_chunks_fts_ad AFTER DELETE ON `document_chunks` BEGIN
  INSERT INTO `document_chunks_fts`(`document_chunks_fts`, `rowid`, `chunk_text`) VALUES ('delete', old.`id`, old.`chunk_text`);
END;