# The look

Every v2 screen has the same look: a clear head, content at a measure, five type steps with hard contrast, real controls, a sign for every thing and lines in two weights. The primitives carry this look by default, so a screen built from them gets it without work. This page states the rules, why they exist, and how to keep the same look where a screen needs a part that v2 does not have.

The reference is the taste study (`v2-taste-study` and `v2-taste-parts` on the Cloud Dev artifacts): three screens before and after, and every part on its own. When this page and an older picture disagree, this page and the study win.

## How a screen is made

1. **Fewer screens, but better ones.** Before you add a page, check that no tab, panel, dialog or filter of an existing page can do the job. Each screen that stays has one clear job, a visible hierarchy and nothing that does not earn its place.
2. **Mockup first.** Draw the screen as a static mockup in the style of the taste parts, with real, dense example data, at 1440 and 390 px, inside the Cloud shell. Write a short brief beside it: who uses the screen for what, the three most important pieces of information in order, and the one hero.
3. **Then build it from v2.** Find the nearest recipe, keep its structure and fill it with data. Use only `@k2b/ui/v2` parts. Where a part is missing, compose it from the tokens below inside a `Canvas`, and write `// k2b-ui gap:` at that place.
4. **Compare.** Put your 1440 and 390 px pictures beside the mockup and the study and fix every difference in rhythm, hierarchy and density before anyone reviews it.

## Rhythm, clarity, intention

- **Rhythm.** Space structures; lines only separate. Rows stand 46 px apart, table cells 44 px, sections 28 px above and 26 px below their content. Use the same steps everywhere, so a page reads as one piece.
- **Clarity.** A person sees in three seconds what the page is and what to do. The head says what the thing is; one filled button says what to do next.
- **Intention.** Every element answers a question the person has. Colour means state or the one main action. Empty space stands only under finished content.

## The thirteen rules

### 1. Measure, not canvas

- **Do:** keep settings and detail content to 1040 px (a head column of 232 px, 48 px gap, up to 760 px of content). Put an action at the end of the content it acts on.
- **Don't:** let a short list run across a 1400 px window, with its action 800 px away from its rows.
- **Why:** the eye loses a line that is too long, and an action far from its object reads as belonging to something else.
- **In v2:** every `Section` in a pane of 960 px and more takes this measure. A section that holds a large table (with selection or a sticky column), tiles, groups or a drawing keeps its full width.

### 2. A head says what it is

- **Do:** open a setting or a detail with the head of its object: the sign, the name in 18, one meta line, up to three key facts, the tabs at its lower edge.
- **Don't:** start a page with only a tab like "General", or repeat the name of the sidebar entry as a title.
- **Why:** the top left is where people look first. An empty or repeated head wastes it.

### 3. Five type steps, hard contrast

- **Do:** use 12 (meta), 13 (row, text, control), 15 (section title), 18 (object name) and 30 (the one key figure of a screen). Use the weights 400, 500 and 600 only. Long reading text (an email, a page of Markdown) is the one place for 14.
- **Don't:** use two sizes less than 2 px apart in one block, or make a counter the largest text.
- **Why:** contrast makes hierarchy. Four sizes within 2 px look like one size that is slightly wrong.
- **In v2:** the type roles `meta`, `row`, `title` and `lead`, `body` for reading text, and the figure once per screen. Counters are always 12 meta.

### 4. Section head A and B

- **Do:** title 15/600 with a quiet count, one or two lines of summary in 13, no symbol. In a wide pane the head is a column of 232 px with its button under the summary (B); in a narrow pane the button stands beside the title (A).
- **Don't:** add a symbol, a grey band or a second line under the head.
- **Why:** a calm head lets the content lead; the column keeps long titles on one line.
- **In v2:** `Section` does this by the width of its pane. There is no prop to choose.

### 5. Actions are buttons

- **Do:** show a section or row action as a framed button of 30 px with its symbol and its verb. Use exactly one filled button per screen.
- **Don't:** use a bare text link such as "+ Zeiten", or a symbol without a word (except "…" and ×).
- **Why:** a person must see what can be pressed and what it does.
- **In v2:** `Section actions` are framed buttons; on the phone they keep their words.

### 6. Row anatomy

- **Do:** sign 28 · name 13/500 · meta 12 on the same line · one data column · the control or the state · "…". Desktop 46 px on one line; phone two lines of at least 52 px.
- **Don't:** show a value that can change as grey text; make it a control in the row.
- **Why:** one row is one thing, readable in one glance and changeable in place.
- **In v2:** `Row` with `avatar` or `mark`, `meta` and a `Select` in `end`.

### 7. Every thing has its sign

- **Do:** give a person an avatar in the stable colour of their name, a group its tinted sign and a stack of members, an object its type sign in its type colour.
- **Don't:** use a grey square with a grey icon, or the same colour for everyone.
- **Why:** signs let people find a thing without reading.
- **In v2:** `Avatar`, `Avatar.Stack`, `Mark`.

### 8. Lines in two weights

- **Do:** use the hair (`--k2-line-subtle`, #f0f0f2) between rows, the quieter column line (`--k2-line-column`, #f5f5f6) between table columns, and the clear line (`--k2-line`, #e4e4e7) between sections, under a head block and under a table head.
- **Don't:** draw a line under the last row or section, or two lines at one edge.
- **Why:** weight tells what belongs together and what is separate.
- **In v2:** the tokens and every primitive that draws a line.

### 9. One data picture per list

- **Do:** let exactly one column show the shape of the data (bars, ticks, a stack, a spark) in the soft app colour. Amber means "too few", red means failure. Use only real data.
- **Don't:** add a picture to every column, or invent a series.
- **Why:** one picture is read; five pictures are noise.

### 10. Surfaces only with meaning

- **Do:** use tint only for the object head, the selection, active filters, choice cards and notices. Use a 1 px card only for a choice, a tile or an island.
- **Don't:** put a box in a box, or a shadow on a control.
- **Why:** a tint that means nothing hides the tint that does.

### 11. Filters are sentences

- **Do:** show an active filter as a sentence in the app tone (field · operator · value · ×), with "and" between them. Saved views are head tabs with counts. The result count and the sort in words stand at the end of the status row; "Reset" appears once something differs.
- **Don't:** build filter chips by hand, or hide the count.
- **Why:** a sentence says what the list shows; a bare chip does not.
- **In v2:** `FilterBar` and `ListOrder` from `defineListQuery`.

### 12. States are finished

- **Do:** load with placeholder rows of the real height and column widths. Show an empty state as sign 40, a sentence in 15/600, one more sentence and one action, in the middle of the area it replaces. Show an error as a notice with "Try again". Show unsaved changes in a floating bar at the bottom.
- **Don't:** show a spinner per row, or a white page.
- **In v2:** `Loading`, `Empty`, `Failed`, `Notice`.

### 13. White space only under finished content

- **Do:** leave space under the content only when the first screen shows at least 60 % real content, or when the page is a complete short setting.
- **Don't:** fill half a screen with nothing; when that happens, a topic is missing (access, a link, the history), not space.

## Custom parts from the tokens

Some screens need a part that v2 does not have. Build it inside a `Canvas` and take every value from the tokens of the scope, so it lands in the same look:

| Need | Token |
| --- | --- |
| text | `--k2-t-meta`, `--k2-t-row`, `--k2-t-body`, `--k2-t-title`, `--k2-t-lead` (as `font`) |
| ink | `--k2-text`, `--k2-muted`, `--k2-subtle`, `--k2-n500` for quiet words |
| lines | `--k2-hairline` (clear), `--k2-hairline-subtle` (hair), `--k2-line-column`, `--k2-line-control` (a control's edge) |
| heights | `--k2-h-row` (46), `--k2-h-cell` (44), `--k2-h-columns` (34), `--k2-h-control` (36), `--k2-h-control-small` (28) |
| edges and radii | `--k2-edge`, `--k2-r-mark`, `--k2-r-control`, `--k2-r-overlay` |
| colour | `--k2-app-text`, `--k2-app-tint` for the app; `--k2-ok`, `--k2-warn-ink`, `--k2-bad` and their tints for state |

Round is what you press; square is what structures. A custom part is checked like any other screen: `measureV2Layout` at 1440 and 390 px, then a picture beside the mockup.
