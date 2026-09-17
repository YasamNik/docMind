# Design Pass: Organic Design System

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Apply the Organic design system from the Claude Design handoff to the existing DocMind React + Tailwind client. Cream/terracotta/sage palette, Caprasimo headings over Figtree body text, pill-shaped small controls, large-radius cards, warm ink-tinted shadows. No new features, no new routes, no server changes.

**Architecture:** The Organic design system defines CSS custom properties for colors (`--color-bg` #f5ead8 cream, `--color-accent` #c67139 terracotta, `--color-accent-2` #7a8a5e sage), fonts (Caprasimo + Figtree), spacing, radii (8/16/28px, 999px pills), and shadows. The existing app uses Tailwind v4 CSS-first configuration in `apps/client/src/index.css` with a `@theme inline` block and `:root` oklch variables consumed by shadcn components (base-ui primitives + CVA variants). The plan redefines those variables, adds the Organic ramp colors, swaps fonts, and restyles each component and page.

**Tech Stack:** Nothing new. Same client stack (React, Vite, Tailwind v4, TanStack Query, shadcn/base-ui). Font packages change (Geist out, Caprasimo + Figtree in).

**Source:** `design-package/` handoff bundle. Read `chats/chat1.md` for intent, then `project/Document Vaults.dc.html` in full, then `project/organic.css` for the design system tokens.

## Global Constraints

- This is a VISUAL redesign only. No new features, no new routes, no server changes.
- Match the mockup's visual output in React + Tailwind. Do not copy the prototype's HTML structure.
- Existing functionality must keep working. All tests must still pass.
- No em dashes anywhere.
- Node 22 via nvm, pnpm via corepack. Before any pnpm command: `source ~/.nvm/nvm.sh && nvm use 22 && corepack enable`.
- Dark mode is deferred (Organic is light-only). The `.dark` block in index.css is left but not refined.
- Mobile mockups (1f) and future-feature mockups (1b vault home, 1c search/ask, 1e sharing) are skipped. Only the visual language is taken from them.

## Decisions

**D1: Color mapping strategy.** Redefine the shadcn `:root` CSS variables with Organic hex values. Add the full Organic ramps (neutral 100-900, accent 100-900, accent-2 100-900) as additional tokens in `@theme inline` for use in component-level styles. Prefix with `org-` where they clash with shadcn token names. This gives global reach through shadcn's existing class system while making the full palette available for custom work.

**D2: Font strategy.** Replace `@fontsource-variable/geist` with `@fontsource/caprasimo` (one weight: 400) and `@fontsource-variable/figtree` (variable, 400/600/700). Self-hosting follows the existing pattern and avoids external Google Fonts calls. If fontsource packages are not available for Caprasimo, fall back to a Google Fonts `@import` in index.css.

**D3: Pill shapes per component.** Buttons, inputs, badges, and tags get `rounded-full` (999px). Cards and dialogs get a large radius (~32px). Applied per component in their CVA config or class strings, not as a global wildcard rule.

**D4: Keep shadcn components, restyle them.** Do not replace @base-ui/react primitives. Update the CVA variants, default classes, and Tailwind tokens within the existing component files. This preserves the accessibility layer (focus management, ARIA, keyboard nav).

**D5: Two-accent badge variants.** Add `accent` and `accent2` badge variants mapping to Organic's tag colors (terracotta tints: accent-100 bg, accent-800 text) and (sage tints: accent-2-100 bg, accent-2-800 text). Add a `neutral` variant (neutral-100 bg, neutral-800 text). Keep existing variants for backward compatibility.

**D6: Skip mockups for unbuilt features.** 1b (vault home), 1c (search/ask), 1e (sharing/retention), 1f (mobile) show features not yet implemented. Only the visual patterns (colors, typography, component shapes) are extracted from them and applied to existing pages.

**D7: Dark mode deferred.** The Organic system is light-only. The `.dark` block stays in CSS but is commented out or left unrefined. No effort spent on dark variant now.

**D8: Lucide icon stroke width.** Set to 2.75 per the Organic readme for a rounder, heavier feel. Applied as a global CSS rule on `.lucide` SVGs.

## Key Design Token Reference

From `organic.css`, for implementers:

| Token | Value |
|-------|-------|
| Background | `#f5ead8` |
| Surface | `#ebddc5` |
| Text | `#201e1d` |
| Accent (terracotta) | `#c67139`, ramp 100-900: `#fff2eb` to `#402310` |
| Accent-2 (sage) | `#7a8a5e`, ramp 100-900: `#f0fae1` to `#272e1b` |
| Neutral ramp | `#f9f4ed` to `#2e2b25` |
| Divider | `color-mix(in srgb, #201e1d 16%, transparent)` |
| Heading font | `Caprasimo`, weight 400 |
| Body font | `Figtree`, weights 400/600/700 |
| Radii | sm 8px, md 16px, lg 28px, pill 999px |
| Shadows | sm `0 1px 2px`, md `0 3px 10px`, lg `0 12px 32px`, all with `#2e2b25` tint |

## File Map

All files under `apps/client/`:

| File | Change |
|------|--------|
| `package.json` | Swap font dependencies |
| `src/index.css` | Full rewrite of tokens, font imports, base styles |
| `src/components/ui/button.tsx` | Pill radius, heading font, Organic color variants |
| `src/components/ui/badge.tsx` | Pill radius, accent/accent2/neutral variants |
| `src/components/ui/input.tsx` | Pill radius, surface bg, accent caret and focus |
| `src/components/ui/card.tsx` | Large radius, surface bg, card-kicker styling |
| `src/components/ui/dialog.tsx` | Large radius, warm overlay, surface bg |
| `src/components/ui/table.tsx` | Organic header (uppercase, tracked), warm row borders |
| `src/components/ui/label.tsx` | Minor: muted color, 12px |
| `src/components/ui/tabs-nav.tsx` | Segment control styling (pill, accent active) |
| `src/components/layout/AppShell.tsx` | Full sidebar reskin |
| `src/components/layout/CategoryTreeNav.tsx` | Colored dots, pill active state |
| `src/components/documents/UploadDropzone.tsx` | Organic dashed border, accent tints |
| `src/pages/auth/SignInPage.tsx` | Cream bg, Organic card/form |
| `src/pages/documents/DocumentsPage.tsx` | Table restyling, tag chips |
| `src/pages/documents/DocumentDetailPage.tsx` | Heading, preview, tag chips |
| `src/pages/tags/TagsPage.tsx` | Card restyling |
| `src/pages/categories/CategoriesPage.tsx` | Card restyling |
| `src/pages/settings/SettingsPage.tsx` | Tab restyling |
| `src/pages/settings/AiTab.tsx` | Minor: spacing, headings |
| `src/pages/settings/ProviderCard.tsx` | Card restyling |
| `src/pages/settings/ModelSlotRow.tsx` | Form restyling |
| `src/pages/settings/StorageTab.tsx` | Form restyling |
| `src/pages/jobs/JobsPage.tsx` | Table + badge restyling |
| `src/pages/sorting/SortingPage.tsx` | Card + dialog restyling |

---

### Task 1: Theme foundation (tokens, fonts, base CSS)

**Goal:** Replace the neutral gray theme with Organic tokens. Every page turns warm after this, before any component work.

**Files:**
- Modify: `apps/client/package.json` (font deps)
- Modify: `apps/client/src/index.css` (heavy rewrite)

- [ ] **Step 1: Swap font packages**

Run: `pnpm remove @fontsource-variable/geist --filter @docmind/client && pnpm add @fontsource/caprasimo @fontsource-variable/figtree --filter @docmind/client`

If `@fontsource/caprasimo` is not on npm, fall back to adding `@import url('https://fonts.googleapis.com/css2?family=Caprasimo&display=swap')` at the top of index.css instead.

- [ ] **Step 2: Rewrite index.css font imports**

Replace `@import "@fontsource-variable/geist"` with:
```css
@import "@fontsource/caprasimo";
@import "@fontsource-variable/figtree";
```

- [ ] **Step 3: Add font tokens to @theme inline**

```css
--font-heading: 'Caprasimo', system-ui, sans-serif;
--font-sans: 'Figtree Variable', 'Figtree', system-ui, sans-serif;
```

- [ ] **Step 4: Add Organic color ramp tokens to @theme inline**

Add the full ramps under `@theme inline`:
```css
--color-org-neutral-100: #f9f4ed;
--color-org-neutral-200: #f0e8dc;
--color-org-neutral-300: #ddd4c5;
--color-org-neutral-400: #b8ad9d;
--color-org-neutral-500: #8a7f70;
--color-org-neutral-600: #645c50;
--color-org-neutral-700: #48423a;
--color-org-neutral-800: #2e2b25;
--color-org-neutral-900: #201e1d;

--color-org-accent-100: #fff2eb;
--color-org-accent-200: #ffdfc8;
--color-org-accent-300: #f5b888;
--color-org-accent-400: #d98a50;
--color-org-accent-500: #c67139;
--color-org-accent-600: #b2622d;
--color-org-accent-700: #8c491a;
--color-org-accent-800: #5c2f0c;
--color-org-accent-900: #402310;

--color-org-accent2-100: #f0fae1;
--color-org-accent2-200: #d9edb8;
--color-org-accent2-300: #b3cf82;
--color-org-accent2-400: #92ad64;
--color-org-accent2-500: #7a8a5e;
--color-org-accent2-600: #5d6d42;
--color-org-accent2-700: #44512f;
--color-org-accent2-800: #2f3820;
--color-org-accent2-900: #272e1b;
```

- [ ] **Step 5: Add Organic shadow tokens**

```css
--shadow-sm: 0 1px 2px color-mix(in srgb, #2e2b25 8%, transparent);
--shadow-md: 0 3px 10px color-mix(in srgb, #2e2b25 10%, transparent);
--shadow-lg: 0 12px 32px color-mix(in srgb, #2e2b25 14%, transparent);
```

- [ ] **Step 6: Redefine :root shadcn variables**

Replace the existing `:root` block values with:
```css
--background: #f5ead8;
--foreground: #201e1d;
--card: #ebddc5;
--card-foreground: #201e1d;
--primary: #c67139;
--primary-foreground: #f5ead8;
--secondary: #eee7db;
--secondary-foreground: #201e1d;
--muted: #eee7db;
--muted-foreground: #645c50;
--accent: #eee7db;
--accent-foreground: #201e1d;
--destructive: oklch(0.577 0.245 27.325);
--border: color-mix(in srgb, #201e1d 16%, transparent);
--input: color-mix(in srgb, #201e1d 16%, transparent);
--ring: #c67139;
--radius: 1rem;
```

- [ ] **Step 7: Handle the .dark block**

Comment out or add a note: `/* Organic is light-only. Dark theme deferred. */`

- [ ] **Step 8: Update @layer base body and html**

Use the new font tokens and background.

- [ ] **Step 9: Add ::selection styling**

```css
::selection { background: color-mix(in srgb, #c67139 30%, transparent); }
```

- [ ] **Step 10: Run typecheck and tests**

Run: `pnpm --filter @docmind/client typecheck && pnpm --filter @docmind/client test`
Expected: PASS. No test references color values.

- [ ] **Step 11: Commit**

```
feat(client): replace theme tokens with Organic design system

Swaps Geist for Caprasimo (headings) and Figtree (body), redefines
the shadcn CSS variables with Organic's cream/terracotta/sage palette,
adds the full accent and neutral color ramps, and sets warm shadows.
Every page now carries the Organic base colors and typography.
```

---

### Task 2: UI primitive restyling

**Goal:** Update each shadcn component to match Organic shapes and colors: pill buttons, pill inputs, large-radius cards, warm badge variants.

**Files:**
- Modify: `apps/client/src/components/ui/button.tsx`
- Modify: `apps/client/src/components/ui/badge.tsx`
- Modify: `apps/client/src/components/ui/input.tsx`
- Modify: `apps/client/src/components/ui/card.tsx`
- Modify: `apps/client/src/components/ui/dialog.tsx`
- Modify: `apps/client/src/components/ui/table.tsx`
- Modify: `apps/client/src/components/ui/label.tsx`
- Modify: `apps/client/src/components/ui/tabs-nav.tsx`

- [ ] **Step 1: button.tsx**

Change base class from `rounded-lg` (or similar) to `rounded-full`. Add `font-heading` to base. Primary variant: `bg-primary text-primary-foreground hover:bg-[#b2622d] active:bg-[#8c491a]`. Secondary: `border-border bg-transparent`. Ghost: `text-primary hover:bg-primary/10`. Adjust padding for pill shape.

- [ ] **Step 2: badge.tsx**

Change base to `rounded-full`. Add variants: `accent` (bg-[--color-org-accent-100] text-[--color-org-accent-800]), `accent2` (bg-[--color-org-accent2-100] text-[--color-org-accent2-800]), `neutral` (bg-[--color-org-neutral-100] text-[--color-org-neutral-800]). Keep existing variants.

- [ ] **Step 3: input.tsx**

Change to `rounded-full`. Set `bg-secondary caret-primary focus-visible:border-primary px-3.5` for pill padding.

- [ ] **Step 4: card.tsx**

Change from `rounded-xl` (or similar) to `rounded-[32px]`. Remove ring, use surface bg.

- [ ] **Step 5: dialog.tsx**

Change popup from `rounded-xl` to `rounded-[32px]`. Overlay: `bg-[#2e2b25]/50`. Popup: surface bg.

- [ ] **Step 6: table.tsx**

Header: `text-[11px] uppercase tracking-wider text-muted-foreground`. Row border: `border-b border-foreground/8`. Hover: `hover:bg-foreground/4`.

- [ ] **Step 7: label.tsx**

Ensure `text-xs text-muted-foreground`.

- [ ] **Step 8: tabs-nav.tsx**

Style as Organic segment control: pill shape, border with divider color, active tab gets primary bg with cream text.

- [ ] **Step 9: Run typecheck and tests**

Run: `pnpm --filter @docmind/client typecheck && pnpm --filter @docmind/client test`
Expected: PASS. Existing tests query by role/text, not class names.

- [ ] **Step 10: Commit**

```
feat(client): restyle UI primitives to Organic design (pills, warm accents, large radii)
```

---

### Task 3: AppShell sidebar and layout

**Goal:** Transform the sidebar from plain gray nav to the Organic sidebar: surface panel, branded header, section headings, colored category dots, pill-shaped active items with accent color, user block at bottom.

**Files:**
- Modify: `apps/client/src/components/layout/AppShell.tsx`
- Modify: `apps/client/src/components/layout/CategoryTreeNav.tsx`

- [ ] **Step 1: Sidebar structure in AppShell.tsx**

Width 236px, `bg-card` (surface), padding 22px 18px, flex column, gap 26px. Remove `border-r`.

- [ ] **Step 2: Brand block**

Flex row: 26px accent circle div + "DocMind" in font-heading text-[19px].

- [ ] **Step 3: Documents nav section**

"Inbox" and "Needs review" with count badges. Pill links: padding 9px 12px, rounded-full, 14px. Active: bg-primary text-primary-foreground.

- [ ] **Step 4: Categories section**

Heading "Categories" in uppercase 10px tracked. Each category link with a 7px circle dot colored by category.color (or neutral-500 default). "Manage" link. Active pill style.

- [ ] **Step 5: Tags section**

Heading "Tags" styled the same. Each tag link with its color dot. Count on the right.

- [ ] **Step 6: Workspace section**

Heading "Workspace". Links for Sorting, Jobs, Settings. Pill nav styling.

- [ ] **Step 7: User block**

margin-top auto, flex row. 30px circle avatar with initials (accent-2 bg, cream text). User name + "Sign out" text link.

- [ ] **Step 8: Main content area**

Padding 26px 30px. Cream background from theme.

- [ ] **Step 9: CategoryTreeNav.tsx**

Each node: flex row with 7px rounded-full dot (category.color or neutral-500), name, count. Pill hover. Active: accent bg + cream text. Children indented with dots.

- [ ] **Step 10: Run tests**

Run: `pnpm --filter @docmind/client test -- AppShell CategoryTreeNav`
Expected: PASS. Tests check text and links, not colors.

- [ ] **Step 11: Commit**

```
feat(client): redesign AppShell sidebar to Organic style (brand, colored dots, pill nav)
```

---

### Task 4: DocumentsPage and UploadDropzone

**Goal:** Restyle the document list and upload area to match mockup 1a.

**Files:**
- Modify: `apps/client/src/pages/documents/DocumentsPage.tsx`
- Modify: `apps/client/src/components/documents/UploadDropzone.tsx`

- [ ] **Step 1: DocumentsPage header**

h2 with font-heading text-[30px]. Subtitle: doc count in text-xs text-muted-foreground. Right: search input + "Add files" primary button.

- [ ] **Step 2: Filter bar**

Style as pills with active = primary, inactive = outline.

- [ ] **Step 3: Document table**

Organic table styling from Task 2. Tag badges use accent/accent2 variants.

- [ ] **Step 4: UploadDropzone**

`border-[1.5px] border-dashed border-foreground/22 rounded-[28px]`. Background: `bg-primary/5`. Plus-icon circle: 38px rounded-full, accent-200 bg, accent-800 text. "Choose files" as secondary button. Drop-active: stronger accent tint.

- [ ] **Step 5: Run typecheck and tests**

Run: `pnpm --filter @docmind/client typecheck && pnpm --filter @docmind/client test`
Expected: PASS.

- [ ] **Step 6: Commit**

```
feat(client): restyle DocumentsPage and UploadDropzone to Organic design
```

---

### Task 5: DocumentDetailPage

**Goal:** Apply Organic document detail styling from mockup 1d.

**Files:**
- Modify: `apps/client/src/pages/documents/DocumentDetailPage.tsx`

- [ ] **Step 1: Category display**

Show as card-kicker (uppercase, 10px, accent) above the heading.

- [ ] **Step 2: Header**

Document name in font-heading text-[34px] for meaningful titles, or text-xl for filenames.

- [ ] **Step 3: Tag chips**

accent/accent2 badge variants. "+ tag" ghost button.

- [ ] **Step 4: Preview area**

rounded-[28px] container with neutral-200 bg for non-previewable types.

- [ ] **Step 5: Extracted text card**

Organic card style (surface bg, large radius). "Text" heading with status badge. Re-extract button.

- [ ] **Step 6: Action bar**

Flex row of primary + secondary + ghost buttons.

- [ ] **Step 7: Run tests**

Run: `pnpm --filter @docmind/client test -- DocumentDetailPage`
Expected: PASS.

- [ ] **Step 8: Commit**

```
feat(client): restyle DocumentDetailPage to Organic design
```

---

### Task 6: Tags and Categories management pages

**Goal:** Restyle the CRUD cards and dialog forms.

**Files:**
- Modify: `apps/client/src/pages/tags/TagsPage.tsx`
- Modify: `apps/client/src/pages/categories/CategoriesPage.tsx`

- [ ] **Step 1: Page headings**

font-heading h2 + primary "New" button.

- [ ] **Step 2: Card list**

Organic card styling from Task 2. Color dot (3px rounded-full circle) next to the name. Document count in accent2 badge. Auto/manual badge in neutral variant.

- [ ] **Step 3: Card actions**

Edit as secondary. Delete as destructive. Move up/down as ghost.

- [ ] **Step 4: Dialog forms**

Inputs already pill-shaped from Task 2. Textarea: `rounded-[28px]`, surface bg. Color input with preview swatch. Range slider: `accent-color: var(--primary)`. Checkbox: accent color.

- [ ] **Step 5: Run tests**

Run: `pnpm --filter @docmind/client test -- TagsPage CategoriesPage`
Expected: PASS.

- [ ] **Step 6: Commit**

```
feat(client): restyle Tags and Categories pages to Organic design
```

---

### Task 7: Settings, Jobs, Sorting, and SignIn pages

**Goal:** Apply Organic styling to all remaining pages.

**Files:**
- Modify: `apps/client/src/pages/settings/SettingsPage.tsx`
- Modify: `apps/client/src/pages/settings/AiTab.tsx`
- Modify: `apps/client/src/pages/settings/ProviderCard.tsx`
- Modify: `apps/client/src/pages/settings/ModelSlotRow.tsx`
- Modify: `apps/client/src/pages/settings/StorageTab.tsx`
- Modify: `apps/client/src/pages/jobs/JobsPage.tsx`
- Modify: `apps/client/src/pages/sorting/SortingPage.tsx`
- Modify: `apps/client/src/pages/auth/SignInPage.tsx`

- [ ] **Step 1: SettingsPage**

Heading in font-heading. Tabs as Organic segment control from Task 2.

- [ ] **Step 2: AiTab/ProviderCard/ModelSlotRow/StorageTab**

Organic card and form styling flows from Tasks 1-2. Headings use font-heading.

- [ ] **Step 3: JobsPage**

Filter buttons as pill toggles. Table with Organic styling. Status badges: done = accent2, failed = destructive, pending/processing = accent.

- [ ] **Step 4: SortingPage**

Apply Organic card and dialog styling to the run dialog and proposals list.

- [ ] **Step 5: SignInPage**

`min-h-screen bg-background` for cream bg. Card: Organic large radius, surface bg. Heading: font-heading. Form inputs: pill-shaped. Submit: primary.

- [ ] **Step 6: Run full test suite**

Run: `pnpm --filter @docmind/client test`
Expected: PASS.

- [ ] **Step 7: Commit**

```
feat(client): restyle Settings, Jobs, Sorting, and SignIn pages to Organic design
```

---

### Task 8: Polish pass (icons, selection, focus, spacing)

**Goal:** Final consistency sweep.

**Files:**
- Modify: `apps/client/src/index.css` (minor additions)
- Various components as needed

- [ ] **Step 1: Lucide icon stroke width**

Add global CSS: `.lucide { stroke-width: 2.75; }` for the heavier Organic icon feel.

- [ ] **Step 2: Verify ::selection styling**

Ensure accent tint is set (may already be from Task 1).

- [ ] **Step 3: Verify :focus-visible rings**

Already flows from `--ring: #c67139`. Spot-check.

- [ ] **Step 4: Heading weights**

Caprasimo only has weight 400. Remove `font-medium` and `font-semibold` from elements using `font-heading`. Check all h1-h4 usages.

- [ ] **Step 5: Button font**

Organic buttons use the heading font. Ensure `font-heading` is on buttons (should be from Task 2).

- [ ] **Step 6: Spacing spot-check**

Organic uses a custom space scale (4.4, 8.8, 13.2, 17.6, 26.4, 35.2px). Tailwind's scale (4, 8, 12, 16, 24, 32) is close enough. Note any glaring mismatches.

- [ ] **Step 7: Root verification**

Run: `pnpm typecheck && pnpm test && pnpm build`
Expected: PASS for all three.

- [ ] **Step 8: Commit**

```
feat(client): polish Organic design pass (icon weight, heading weights, focus rings)
```

---

## Verification

After all 8 tasks:
1. `pnpm test` from root passes (server tests unaffected, client tests green).
2. `pnpm typecheck` from root passes.
3. `pnpm build` succeeds.
4. Visual spot-check of every page:
   - **SignInPage**: Cream bg, centered surface card, Caprasimo heading, pill inputs, terracotta submit button.
   - **DocumentsPage**: Warm sidebar with brand, colored category dots, Organic table, pill tag badges, Organic upload dropzone.
   - **DocumentDetailPage**: Breadcrumb, Caprasimo heading, tag chips in accent/accent2, preview container, surface text card.
   - **TagsPage / CategoriesPage**: Organic cards with colored dots, pill badges, warm dialog forms.
   - **SettingsPage**: Segment tab control, provider cards in Organic style.
   - **JobsPage**: Organic table, status badges in warm accent variants.
   - **SortingPage**: Organic cards, run dialog, proposals list.
5. Functional checks: upload a file, navigate sidebar, open dialogs, toggle settings tabs.

## Risks

1. **Font availability**: If `@fontsource/caprasimo` is not on npm, fall back to Google Fonts `@import`. This adds an external dependency. Check npm registry before starting.
2. **Color contrast on accent text**: Terracotta #c67139 on cream #f5ead8 has ~3.1:1 contrast. Meets WCAG AA for large text and UI components, but NOT for small body text. Use accent-700 (#8c491a) for paragraph-size accent text.
3. **Pill input clipping**: Long text in pill-shaped inputs has less horizontal space. Test with long settings values and model names.
4. **Dark mode break**: If a user has OS dark mode and the app formerly respected it, it will look wrong. Ensure the html element does not carry a `dark` class.
5. **Test fragility**: If any test asserts on specific Tailwind class names, it will break. Scan tests before starting.
6. **Toaster (sonner) styling**: May need custom theme props to match Organic colors.
