# CommandMenu

`CommandMenu` opens a searchable list of commands from a "+" button, a chip, or an anchor. `SlashCommands` shows the
same list in a `MarkdownEditor` when a person types `/` (see [MarkdownEditor](/en/ui/input/markdown-editor#slash-commands)).
Both read one `CommandItem[]`, so a composer's `/`, its "+" button, and a chip never disagree.

## Use CommandMenu

Use it for a composer or another place where people insert or attach things: switch what they record, insert a text
snippet, look something up for the text, assign a person, or add a tag. Pass the same entries to `SlashCommands`
beside the editor.

Use [Dropdown](/en/ui/actions/menus) for the secondary actions of an object, such as Duplicate or Archive. Use a select control to
choose a form value.

## Import

```tsx
import { type CommandContext, type CommandItem, CommandMenu, MarkdownEditor, SlashCommands } from "@k2b/ui";
```

## Entries

Every entry has a `label` and exactly one of three outcomes:

| Outcome | Field | What happens |
| --- | --- | --- |
| Run a command | `onSelect: (context) => unknown` | It runs with the text it acts on, see [Context](#context). In the editor, the typed `/query` leaves the text first. |
| Insert text | `text: string` | The editor puts the text in place of `/query`; `CommandMenu` writes it into its `target` or hands it to `onInsert`. |
| Open a second list | `next: { label, items }` | The same list shows the second list, such as people or tags. `label` names it and is its search hint. |

Further fields:

| Field | Purpose |
| --- | --- |
| `group` | Heading above the entry. Entries of one group stand together, in the order the groups first appear; entries keep their order. |
| `description` | What the entry does, quiet on the same line after the label, such as "Preis zur Artikelnummer im Text". It is searched. |
| `icon` | Tabler icon class, such as `ti ti-phone`. |
| `image` | An image at icon size in place of the icon, such as a service's logo: a URL, or `{ light, dark }` when the logo needs a light variant on dark surfaces. It is decorative. |
| `leading` | `() => JSX.Element` in place of the icon, such as an avatar or a tag color. A function, so each row gets its own element. |
| `hint` | Very quiet text at the end of the row, such as what to type: `/call`. It is searched without its slash. Prefer a `description`. |
| `keywords` | Further words that find the entry, such as `"anruf"` for "Phone call". |
| `disabled` | A one-line reason. The entry stays in the list, greyed, with the reason in the description's place, and cannot be chosen. |
| `id` | Stable key, only when two entries share group and label. |

`items` of the menu and of a second list is a list, or a function `(query) => CommandItem[]` for a list the
application filters itself, such as a person search.

## Context

`onSelect` receives one `CommandContext`, in the editor and in the menu:

| Field | In `SlashCommands` | In `CommandMenu` |
| --- | --- | --- |
| `text` | The editor's text, without the typed `/query` | The text of its `target`, or empty without one |
| `selection` | `{ start, end }` in that text; `start === end` is the caret | The same in `target`, or `{ start: 0, end: 0 }` |
| `insert(text)` | Puts text at the caret in place of the selection, as typing would, so undo keeps working | Writes into `target` the same way, or hands the text to `onInsert` |
| `signal` | Aborts when the person closes the list with <kbd>Esc</kbd> before a returned promise settled | The same, also when the menu closes otherwise |

A command that returns a promise runs in place: the list stays open, the entry shows a spinner instead of its icon,
and other entries wait. The text keeps the focus. When the promise settles, the list closes. When it rejects, the entry
shows the error's message in its description's place, quiet in the danger color, cut to one line with the full text as
its title, and an alert reads the message. Choosing the entry again runs it again; typing moves on and closes the list.
Any other return value counts as done, so `onSelect: () => setKind("call")` keeps working. Keep error messages short:
"Keine Artikelnummer im Text".

## Docking

`SlashCommands` docks its list to the composer: exactly as wide as the composer and flush with its edges, 6 px above
it. Near the top of the window, where there is more room below, it docks below instead. It follows the visible
viewport, so a phone's open keyboard does not hide it, and it never moves the composer. Pass the composer box, such as
the frame around the editor and its "+" row, as `composer`; without it the list docks to the editor.

Give `CommandMenu` the same box as `dock` to dock the "+" menu the same way. Without `dock`, it opens beside its
trigger, at least 20rem and at most 28rem wide.

The list is at most 24rem high and scrolls. Docked, it keeps the composer's width and stays flat: its frame sets it
apart, and no shadow falls on the text.

## Search

A list filters by label, description, hint, and keywords. Every word of the query must match. Case and accents do not
matter, and a spelled-out umlaut matches too: "zustaendig" and "zustandig" both find "zuständig".

## Keyboard

The focus stays in the search field (in the editor: in the text). The marked entry is the field's active descendant.

| Key | Action |
| --- | --- |
| <kbd>↑</kbd> <kbd>↓</kbd> | Mark the previous or next entry, wrapping. Unavailable entries are passed over. |
| <kbd>Home</kbd> <kbd>End</kbd> | Mark the first or last entry that can be chosen. |
| <kbd>Enter</kbd> <kbd>Tab</kbd> | Choose the marked entry. While a command runs, nothing else runs. |
| <kbd>Esc</kbd> | Stop a running command and close; leave a second list; in the first list, close. |
| <kbd>Backspace</kbd> | In an empty field, leave a second list. |

A pointer chooses with a click and marks an entry it moves over; unavailable entries are never marked. The back control
above a second list returns to the first.

## Properties

| Property | Type | Purpose |
| --- | --- | --- |
| `items` | `CommandItem[] \| (query) => CommandItem[]` | The entries. |
| `label` | `string` | Names the menu and its first list, such as "Add to message". |
| `search` | `string` | Names the search field and is its hint. A second list shows its own label there. |
| `target` | `HTMLTextAreaElement \| HTMLInputElement` | The field the commands act on, such as the composer's textarea. |
| `dock` | `HTMLElement` | The composer box the menu docks to. |
| `onInsert` | `(text: string) => void` | Receives inserted text when there is no `target`. |
| `position`, `align` | as `Dropdown` | Where the menu opens beside its trigger, without `dock`. |
| `openAt` | as `Dropdown` | Opens the menu beside an anchor without a trigger. |
| `attach` | as `Dropdown` | Adopts a server-rendered element as the trigger. |
| `onOpenChange`, `disabled`, `class` | | As `Dropdown`. |

Place `CommandMenu.Trigger` inside; it takes the props of `Dropdown.Trigger`.

## Layout and states

- Every entry is one line: its icon, image, or avatar in one slot, so all labels start on the same line; the label;
  then quietly its description, unavailable reason, or failure; a `›` for a second list. The description gives way
  first, then the label, each with an ellipsis. On narrow screens the hint leaves.
- An image keeps its 16 px box before it loads, so the row never moves.
- An unavailable entry is greyed: muted label, faint icon or image, no hover fill.
- A query without matches shows "No results"; a polite status says how many entries match, or which command runs.
- Rows use the menu rows of `Dropdown`, 44 px tall on touch devices. On a phone the menu's field uses 16 px text so
  the page does not zoom.

## Accessibility

The field is a combobox that controls a list box. Groups are labeled by their heading. An unavailable entry has
`aria-disabled="true"` and its reason in its name. A running entry has `aria-busy="true"`, and a polite status names
it; a failure is read by an alert. The hint, the image, and the leading element are hidden from assistive technology;
the label names the entry.

## Runtime

`CommandMenu` is interactive and requires browser code. The surrounding page can remain server rendered; the trigger
renders on the server.

## Example

```tsx
const commands: CommandItem[] = [
  { group: "Art", label: "Telefonat", description: "Anruf festhalten", icon: "ti ti-phone", keywords: ["anruf"], onSelect: () => setKind("call") },
  { group: "Vorlagen", label: "Fotos erbeten", description: "Bittet um Fotos der Rückseite", icon: "ti ti-photo", text: "Könnten Sie uns noch zwei Fotos schicken?" },
  {
    group: "Marktplätze",
    label: "Marktpreis prüfen",
    description: "Preis zur Artikelnummer im Text",
    image: "/logos/troedelplatz.svg",
    onSelect: async ({ text, insert, signal }) => {
      const article = /Art\.\s*(\d+)/.exec(text)?.[1];
      if (!article) throw new Error("Keine Artikelnummer im Text");
      insert(await priceHint(article, { signal }));
    },
  },
  { group: "Aktionen", label: "Termin bestätigen", icon: "ti ti-calendar-check", disabled: "Nur mit einer Ankündigung", onSelect: confirm },
  {
    group: "Aktionen",
    label: "Kunde zuordnen",
    description: "Aus der Kundenliste",
    icon: "ti ti-user-plus",
    next: {
      label: "Kunden suchen",
      items: customers.map((customer) => ({
        label: customer.name,
        leading: () => <Avatar name={customer.name} size="xs" />,
        onSelect: () => assign(customer),
      })),
    },
  },
];

const [textarea, setTextarea] = createSignal<HTMLTextAreaElement>();
const [composer, setComposer] = createSignal<HTMLDivElement>();

<div ref={setComposer} class="composer">
  <MarkdownEditor variant="embedded" noToolbar value={text()} onValueChange={setText} textareaRef={setTextarea} />
  <SlashCommands textarea={textarea()} items={commands} composer={composer()} />
  <CommandMenu items={commands} label="Hinzufügen" search="Befehle suchen" target={textarea()} dock={composer()}>
    <CommandMenu.Trigger iconOnly label="Hinzufügen">
      <i class="ti ti-plus" aria-hidden="true" />
    </CommandMenu.Trigger>
  </CommandMenu>
</div>
```
