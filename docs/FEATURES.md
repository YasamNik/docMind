# DocMind feature list

Draft under discussion, 2026-09-15. Tiers first, effort per item comes next.

Vision: a private assistant and secretary that remembers everything you give it, keeps
your documents in order, watches dates and money, talks to you through Telegram and the
app, and acts on your calendar and mail with your approval. Documents are the memory;
the assistant features are modules over it.

Assumption behind the split: v1 is a self-hosted tool for one person, a product for
others later. Sections: Documents, Notes, Collections, Tasks and Reminders, Calendar,
Correspondence, Contacts, Wiki, Investments.

Effort column values, to be filled in together: S (hours), M (a day or two), L (a week),
XL (more than a week).

## Must have: the core loop works end to end

| # | Feature | What it means | Effort |
|---|---------|---------------|--------|
| 1 | Sign in | Single user, email and password, sessions | |
| 2 | Upload | Drag and drop, multiple files, progress, size limit, duplicate detection by content hash | |
| 3 | Text extraction | PDF, images with OCR, DOCX, XLSX, PPTX, text and Markdown. Status per document, retry on failure | |
| 4 | Document library | List with filters by tag, category, type, date. Inline preview for PDF and images. Rename, download, delete | |
| 5 | Tags and categories | Create, edit, color, nested categories, manual assignment, applied-by shown (rule or manual) | |
| 6 | Rules engine | Plain English rules, batch evaluation per document, confidence threshold, reasoning visible, re-evaluate on demand, dry run against one document before saving | |
| 7 | Search | Keyword, semantic, hybrid, with filters and highlighted snippets | |
| 8 | Chat | Questions over all documents, streaming, citations that open the source at the cited chunk, saved sessions | |
| 9 | Settings | AI providers with model slots, test connection, setup guides. Storage drivers with guides and OAuth connect. Encrypted secrets | |
| 10 | Pipeline visibility | Jobs view: pending, running, failed, retry. A stuck document is never a mystery | |
| 11 | Deployment | Docker image, compose file, env example, first-run wizard for encryption key, first user, provider, storage | |

## Should have: first releases after the loop works

| # | Feature | What it means | Effort |
|---|---------|---------------|--------|
| 12 | Auto summary and title | Generated at ingest, shown in the library | |
| 13 | Smart fields | Generic extracted metadata: dates, amounts, parties, document type. Filterable | |
| 14 | Software tools collection | A fixed table (name, purpose, URL, category, source, author, date found, notes). Share a link, AI extracts rows, confirm, insert. Source stored as a document. Duplicates merged by URL | |
| 15 | Telegram intake | Personal bot with your token, accepts only your user ID, forwards links and posts into the collection flow, replies with what it added | |
| 16 | Notes with sections | User-defined sections, each with a one-line description of what belongs there. Send a text note by UI or Telegram; the AI picks the section by description, rewrites it into clean prose or a list, appends it with a timestamp. Raw text kept beside the cleaned version. Ambiguous notes go to Inbox. Notes are searchable and usable by chat | |
| 17 | Voice notes | Voice messages by UI or Telegram transcribed through the AI provider layer (OpenAI-compatible or OpenRouter transcription, local Whisper later), then filed like text notes. Transcript kept | |
| 18 | Email intake | Watch a mailbox folder or label over IMAP with an app password. Each email becomes a document (subject as title, body as text), each attachment a linked document. Rules run on both. Sender allowlist, processed label so nothing ingests twice. Gmail via the Drive OAuth app and inbound webhook services later | |
| 19 | Smart Telegram bot | Beyond intake: ask questions and get answers with links, set reminders in plain language (one-off and recurring) and receive them, reminders link back to documents. Daily digest built from interest topics the user configures as sentences, covering new documents, notes, wiki changes, saved links | |
| 20 | Calendar connection | Google Calendar through the same Google OAuth app as Drive with the calendar scope, Outlook through the same Microsoft app as OneDrive, CalDAV later for iCloud, Fastmail, Nextcloud. Reminders become events with the linked document in the description, renewals and expiries push as events, the digest shows today's schedule, the bot understands schedule requests and answers what is on tomorrow. Nothing is created without being shown first | |
| 21 | Tasks and commitments | A task list fed by the bot and notes. Commitments found in mail and documents ("reply by Friday") become tasks with due dates. The bot follows up when they slip | |
| 22 | Morning brief | The daily digest as a briefing at a chosen time: today's schedule, due tasks, unanswered mail, expiries, portfolio events, new documents | |
| 23 | Inbox triage | New documents land in an Inbox with the AI's proposed title, summary, tags, category. One tap accepts, or fix it. Rules still run, results are visible before they become fact | |
| 24 | Rules learn from corrections | An override of a rule's decision stores the document as an example on that rule. The next evaluation includes recent examples in the prompt | |
| 25 | Rule suggestions | The model proposes rules from a sample of your documents | |
| 26 | Bulk actions | Multi-select to tag, categorize, re-evaluate, delete | |
| 27 | Trash with restore | Soft delete, restore, purge | |
| 28 | Saved searches | Behave like smart folders | |
| 29 | Export and backup | Zip of files plus metadata JSON, and import of the same | |
| 30 | Move documents between storage drivers | The follow-up job from the storage design | |
| 31 | Failure notifications | For extraction, rule, embedding, and collection jobs | |
| 32 | Renewals and expiries | Smart fields find dates; add an expiry type, a reminders view, Telegram nudges at 30 and 7 days. Passports, insurance, domains, subscriptions, warranties | |
| 33 | Dark mode and keyboard shortcuts | | |
| 34 | Knowledge wiki | Karpathy LLM wiki pattern. Library is the immutable raw sources. LLM-maintained markdown pages with wikilinks: one summary per document, entity pages, concept pages, a log. Ingest job updates affected pages after extraction. Chat queries the wiki first, raw chunks as backup. Lint checks broken links, duplicate entities, contradictions, orphans, with an approved report before edits. Mirrored as a folder on the storage driver so it opens as an Obsidian vault. In-app graph view later. Largest item on the list | XL |

## Nice to have: later, some are big

| # | Feature | What it means | Effort |
|---|---------|---------------|--------|
| 35 | User-defined collections | Any table with custom columns, Software tools becomes a template | |
| 36 | Ingestion sources | Watched folder, browser share target, mobile PWA with camera scan, inbound email webhook | |
| 37 | Scoped chat and chat actions | Chat over one category, tag, or result set. Actions like "tag these as Medical" | |
| 38 | Deadlines and expiry | Dates extracted from documents surface as reminders | |
| 39 | Document relationships | Link related documents, merge duplicates, versions | |
| 40 | External OCR providers | Mistral OCR, Azure Document Intelligence for hard scans | |
| 41 | Fully local mode | Ollama plus a local embedding model, no cloud calls | |
| 42 | Per-document privacy flag | Local only: never sent to a cloud provider. Local extraction and embeddings, skipped by rules and chat unless a local model is active | |
| 43 | Read-it-later queue | Any article or post link shared to the bot: clean text captured as a document with a summary, Reading queue, feeds the wiki. Collection extraction is a special case of this | |
| 44 | Cite the exact spot | Keep OCR word positions. Citations open the page image with the cited passage highlighted | |
| 45 | Portfolio watch | Holdings as a collection (ticker, quantity, cost basis, account), fed by parsed brokerage statements. Market data from a free API with a settings entry and guide. Alerts on user rules: price thresholds, daily moves, earnings and dividend dates, concentration, a holding mentioned in a saved article. Daily brief on holdings with citations. Observations only, never buy or sell suggestions, plain disclaimer in the UI | |
| 46 | Correspondence | Draft replies and letters from your documents and history, in your tone. Sent only after approval, through Gmail or Outlook via the existing OAuth apps | |
| 47 | Contacts and context | People and companies directory built from wiki entity pages. Each contact shows the documents, mail, and notes they appear in and the last thing that happened | |
| 48 | Form filling | Fill a PDF form or web form from your documents: policy numbers, addresses, IDs. Reviewed before anything leaves | |
| 49 | Meeting notes | Upload or send a recording: transcript, summary, decisions, action items that land in tasks | |
| 50 | Travel and bookings | Confirmation mail becomes an itinerary with calendar events and the documents attached | |
| 51 | API and MCP server | Other agents and tools can search and read your documents and collections | |
| 52 | Rule starter packs | Receipts, medical, legal, household | |
| 53 | Public share links | For single documents | |
| 54 | Multi-user and sharing | Organizations, roles, sharing. Explicit non-goal for now | |
| 55 | UI translations and multilingual OCR | | |

## Delivery phases

Every phase ends with something the user runs daily. Later phases are sketches and get
their own brainstorm, spec, and plan when reached. This supersedes the four-phase build
order in DOCMIND-DESIGN.md.

| Phase | Name | Outcome | Items |
|-------|------|---------|-------|
| 1 | Smart sorting | Drop documents in, they get read and filed | 1, 2, 3, 4, 5, 6, 9 (OpenRouter and local storage only), 10, 11 |
| 2 | Find and ask | Ask your documents questions | 7, 8, 12, 23 |
| 3 | Intake from anywhere | Things reach DocMind without opening it | 15, 16, 17, 18, 19 (questions only), 9 (S3, Drive, OneDrive) |
| 4 | Secretary basics | It starts acting on your behalf | 19 (reminders, digest), 20, 21, 22, 32, 24, 31 |
| 5 | Collections | Structured knowledge, not just files | 14, 13, 43, 26, 27, 28, 29 |
| 6 | Knowledge wiki | Chat that gets smarter over time | 34, 37, 47 |
| 7 | Investments | Money watched the same way dates are | 45 |
| 8+ | Secretary, full | Correspondence, form filling, meeting notes, travel, user-defined collections, privacy flag, local mode, API and MCP, multi-user, and the rest | the remaining items |
Item numbers refer to the tables above. Renumber this table when the tables change.

## Notes from the discussion

- DocMind is a platform with sections. Documents is the main one. The others so far:
  Notes, Collections, Reminders, Wiki, Investments. Each is a module over the same
  library, settings, jobs, and bot. None of them bends the core.
- Connections (Google, Microsoft) are registered once and reused: one Google OAuth app
  covers Drive, Calendar, and later Gmail. One Microsoft app covers OneDrive and Outlook.

- X posts cannot be fetched anonymously. Use a mirror API that returns the post as JSON
  including images, with pasting the text as the fallback.
- One shared post can yield many rows. The extraction returns a list, and the user
  confirms before insert.
- Section picking for notes is the rules engine pointed at sections instead of tags.
  Same evaluation, same confidence threshold, same stored reasoning.
- The knowledge wiki is the compounding layer. Every intake path (upload, email,
  Telegram, notes, collections) ends in the same ingest job that updates wiki pages.
