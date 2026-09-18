# Schema change rules (mandatory)

Adding a column to a Drizzle `*.tables.ts` file without a corresponding migration
breaks the live dev server immediately. The tsx watcher restarts, Drizzle generates SQL
referencing the new column, and every query fails with "no such column."

## When a task adds a new column to any `*.tables.ts` file

1. Generate the migration in the SAME task, before finishing.
2. If `db:generate` is blocked or the task cannot generate it, do NOT add the column
   to the tables file. Instead, leave a comment `// TODO: add documentDate after migration`
   and note it in the report.
3. Never leave a tables file with columns that have no migration. The dev server will
   break for the user.

## When reviewing agent reports

If a coder agent reports adding columns to `*.tables.ts` but did not generate a
migration, the coordinator must either:
- Generate the migration immediately before committing, or
- Revert the column addition before committing

The user has been burned by this pattern three times (2026-09-17). It is not acceptable.
