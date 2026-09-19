-- Hand-edited: drizzle-kit generates this as a plain ALTER TABLE ADD COLUMN and drops
-- the ON DELETE CASCADE clause even though documents.tables.ts declares it. The clause
-- was added back by hand. Do not regenerate this file from the schema; a future
-- `db:generate` will not touch it since the snapshot already records the cascade.
ALTER TABLE `documents` ADD `parent_document_id` text REFERENCES documents(id) ON DELETE CASCADE;
