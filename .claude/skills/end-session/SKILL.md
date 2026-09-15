---
name: end-session
description: Use when the user says they are done, asks to wrap up, end the session, or push at the end of a DocMind work session, or when the conversation is clearly closing. Also use when the user asks to save a session summary.
allowed-tools: Bash(git add:*), Bash(git commit:*), Bash(git status:*), Bash(git log:*), Bash(git diff:*), Bash(git branch:*), Bash(git remote:*)
---

# End session

Close a DocMind session so the next one can start cold. Five outputs, in this order:
a WORKLOG entry, memory updates, a bug record proposal, a docs commit, a closing message.
Do them all. Do not ask questions before step 5; there is nothing to decide until then.
No em dashes or en dashes in anything you write, including the closing message.

## 1. Gather evidence

```bash
git status --short && git branch --show-current && git log --oneline -15 && git remote -v
```

Then reread the conversation for what git does not show: decisions, the user's exact
words, bugs investigated, things deferred.

**If `git status` shows uncommitted code changes:** leave them alone. They are not
part of the docs commit. Name them in the closing message and let the user decide.

## 2. Append the WORKLOG entry

Insert below the `Active branch:` line in `WORKLOG.md`, above the previous entry.
Update `Active branch:` to the current branch. Exact shape:

```markdown
## YYYY-MM-DD: <three to six word title>

### Done
- <what shipped, with file paths and commit subjects>

### Decisions
- <what was chosen and why the alternative lost>

### Comments
- "<the user's words, verbatim, one quote per bullet>"

### Open / Next
- <unfinished work, deferred items, the first thing to do next session>
```

Comments are quotes, not paraphrases. That section is what makes the log useful later.

## 3. Update memory

Memory directory: `/home/alexander/.claude/projects/-home-alexander-Documents-GitHub-docMind/memory/`

Memory holds distilled facts, one per file, not a session narrative. The WORKLOG is
the narrative.

- **Overwrite** `docmind-current-state.md` with the current branch, what shipped this
  session in one line, and the first thing to do next session. Frontmatter:

  ```markdown
  ---
  name: docmind-current-state
  description: Where DocMind work stands and what to do first next session
  metadata:
    type: project
  ---
  ```

- **Create one file per new durable fact**: a user preference or correction
  (`type: feedback`), a design decision that constrains future work
  (`type: project`), an external resource (`type: reference`). Same frontmatter
  shape with a kebab-case `name`. Body ends with `**Why:**` and `**How to apply:**`
  lines. If a file already covers the fact, update it instead.
- **Update `MEMORY.md`**: one line per new or renamed file, `- [Title](file.md) - hook`.
  Never put fact content in the index.

A durable fact is one a future session would get wrong without it and cannot learn
from the code, the tests, git history, or the WORKLOG. A typical session yields zero
to two new files. Not memory: how code works (the code and its tests record that), a
deployment value, or anything the WORKLOG entry already says.

## 4. Check the bug log

If a bug was fixed this session, grep `docs/bugs_fix_tracking.md` for it. If it is
absent, the closing message must propose recording it (step 5). Do not record it
yourself. Do not run the `bug-fix-record` agent. Recording needs the user's explicit
yes, every time.

## 5. Commit the docs, then report

```bash
git add WORKLOG.md CLAUDE.md docs/
git commit -m "docs(worklog): session YYYY-MM-DD"
```

Add `CLAUDE.md` only if conventions or setup steps changed this session. Include the
attribution trailer the harness provides.

**If the user asked to push** (the words "push" or "push it" in their closing message)
and the branch is not `main` and a remote exists: `git push -u origin <branch>`. Report
the PR link `https://github.com/YasamNik/docMind/compare/main...<branch>?expand=1`.
Otherwise do not push. Never push `main`. Never force push.

Closing message, in this order, short:

1. What was committed and on which branch, and whether it was pushed.
2. Uncommitted code changes, if any, by file.
3. Bug record proposal, if step 4 found one: "Record the <title> fix in the bug log?"
4. The first thing to do next session.

## Red flags

| Thought | Reality |
|---------|---------|
| "The memory can just be the worklog entry again" | Memory is facts with frontmatter. Duplicated narrative never gets read. |
| "I'll log the bug now, it's obviously fine" | Recording needs an explicit yes. Propose it and stop. |
| "They said push, so push" | Push only a feature branch with a remote. Main and force are never pushed. |
| "No need to quote, I'll summarize what they said" | Quotes are the point of the Comments section. |
