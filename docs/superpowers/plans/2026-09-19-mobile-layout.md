# Make DocMind usable on a phone

> **For agentic workers:** Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every page works on a 390px screen: nothing clipped, nothing needing a horizontal
scroll, every control reachable with a thumb.

**Why now:** the user opened the app on their phone and called it "completely not
compatible with mobile". They are right. The shell hard-codes a 60px icon rail beside a
220px context panel, both always visible, which leaves about 110px of content on a phone,
and the whole client contains 8 responsive classes.

**This is not a redesign.** The Organic design pass settled the palette, the typefaces
(Caprasimo and Figtree) and the component shapes. Every token stays. Only layout changes,
and only below the breakpoint. A desktop screenshot after this work should look identical
to one before it.

## The rules, shared by every task

- **Breakpoint: Tailwind `md` (768px).** Below it is the phone layout, at and above it
  nothing changes. Write mobile first (`flex-col md:flex-row`), never `md:` overrides of a
  desktop base, so the phone case is the plain reading of the markup.
- **No horizontal scrolling of the page, ever.** A wide thing becomes a stacked thing, not a
  scrollable thing. The one exception is a deliberately scrollable strip, like a tab bar,
  which must look scrollable.
- **Touch targets are at least 44px** in both directions. Several icon buttons are currently
  well under that.
- **Text inputs use a 16px font on mobile.** Anything smaller makes iOS Safari zoom the page
  on focus, which then leaves the layout scrolled sideways.
- **Respect the safe area** at the bottom (`env(safe-area-inset-bottom)`) wherever something
  is pinned there, or it sits under the home indicator.
- Tokens, colors, radii, typefaces and copy stay exactly as they are. No em dashes.

## Verification, for every task

Tests and typecheck are necessary but they do not see layout. Also check the real thing:
`pnpm --filter @docmind/client exec vitest run <files>`, the full client suite, and
`pnpm --filter @docmind/client exec tsc -b --noEmit`.

---

### Task 1: The shell

**Files:** `apps/client/src/components/layout/AppShell.tsx` and its test.

Today: a 60px icon rail and a 220px context panel, both `shrink-0`, always rendered.

Below `md`:

- A sticky top bar: a menu button, the current section's name, and the theme toggle.
- The menu button opens a slide-over holding both levels of navigation: the sections the
  rail shows as icons, here as a labelled list, and under them the context panel's contents
  for the current section. Choosing anything closes it.
- Content takes the full width, with the page padding the desktop layout already uses.
- The unread and failure indicators must survive into the top bar. A badge that only exists
  inside a hidden drawer tells nobody anything.

At `md` and above the current layout renders unchanged.

- [ ] Write the failing tests: the rail and context panel are not rendered below the
      breakpoint, the menu opens a navigation drawer, choosing a destination closes it, and
      the failure indicator is visible without opening anything.
- [ ] Implement, run, commit: `feat(client): a navigation shell that fits a phone`

---

### Task 2: The documents table, and the tables like it

**Files:** `apps/client/src/pages/documents/DocumentsPage.tsx`, `InboxPage.tsx`,
`JobsPage.tsx` and their tests.

The documents table has nine columns including a checkbox, tags, two dates, type and size.
No phone shows that as a table, and squeezing it produces either clipping or a sideways
scroll.

Below `md`, each row becomes a stacked card: the name as the heading, the category and tags
as chips under it, and the facts that matter (added date, expiry, size) on one quiet line.
The row stays a link to the document. Selection for bulk actions stays available as a
checkbox on the card.

Column sorting and the header filter dropdowns have no place on a phone card list: put the
sort and the active filters in a single control above the list, showing what is currently
applied. Do not simply hide the filters, or the list becomes a thing the user cannot narrow.

- [ ] Write the failing tests: below the breakpoint the table is not rendered, a card per
      document is, the card links to the document, filtering and sorting are still reachable.
- [ ] Implement, run, commit: `feat(client): document lists that read as cards on a phone`

---

### Task 3: Chat, search, and the detail page

**Files:** `apps/client/src/pages/chat/ChatPage.tsx`,
`apps/client/src/pages/search/SearchPage.tsx`,
`apps/client/src/pages/documents/DocumentDetailPage.tsx` and their tests.

- **Chat**: the sessions list moves into a sheet opened from the page header, so the
  conversation gets the whole screen. The composer pins to the bottom above the safe area,
  and the message list scrolls under it. This is the page most likely to be used on a phone,
  so it should feel like a messaging app rather than a desktop page that shrank.
- **Search**: the field goes full width and the result cards stack. The storage badges and
  scores stay, they are small.
- **Detail page**: the preview, the extracted details grid and the tag and category pickers
  all stack into one column. The two and three column grids collapse. The preview gets a
  sensible maximum height so the metadata below it is not pushed off the screen.

- [ ] Write the failing tests for each page, implement, run.
- [ ] Commit: `feat(client): chat, search and document pages that stack on a phone`

---

### Task 4: Dialogs, settings, and the long tail

**Files:** `apps/client/src/components/ui/dialog.tsx`, the settings tabs, `TagsPage`,
`CategoriesPage`, `SortingPage`.

- **Dialogs** below `md` go full height and full width, with their actions pinned where a
  thumb reaches. A centered 500px modal on a 390px screen currently overflows.
- **Settings** has five tabs in a row that will not fit: make the tab strip scroll
  horizontally and look scrollable. Inside, the storage tab's `280px 1fr` grid stacks, and
  every settings field and its Save control stacks rather than sitting side by side.
- **Tags, Categories, Sorting**: check each at 390px and fix what clips. These are simpler
  pages and may need only a grid change.

- [ ] Work through each, with tests where behavior changes rather than only layout.
- [ ] Commit: `feat(client): dialogs and settings that fit a small screen`

---

## Self-review

**What this deliberately does not do.** No new visual language, no new components where an
existing one stretches, no redesign of anything that already works on a desktop. The
smallest set of layout changes that makes the phone case work.

**The risk.** Four agents touching the client at once could produce four dialects of the
same idea. The shared rules at the top exist for that reason: one breakpoint, mobile first,
stack rather than scroll.
