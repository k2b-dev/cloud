# CommandMenu

`CommandMenu` opens a searchable list of commands from a "+" button, a chip, or an anchor. `MarkdownEditor` shows the
same list when a person types `/` (see [MarkdownEditor](/en/ui/input/markdown-editor#slash-commands)). Both read one
`CommandItem[]`, so a composer's `/`, its "+" button, and a chip never disagree.

## Use CommandMenu

Use it for a composer or another place where people insert or attach things: switch what they record, insert a text
snippet, assign a person, or add a tag. Pass the same entries to `MarkdownEditor`'s `commands`.

Use [Dropdown](/en/ui/actions/menus) for the secondary actions of an object, such as Duplicate or Archive. Use a select control to
choose a form value.

## Import

```tsx
import { CommandMenu, type CommandItem, MarkdownEditor } from "@k2b/ui";
```

## Entries

Every entry has a `label` and exactly one of three outcomes:

| Outcome | Field | What happens |
| --- | --- | --- |
| Run an action | `onSelect: () => void` | The menu closes, then the handler runs. In the editor, the typed `/query` leaves the text first. |
| Insert text | `text: string` | The editor puts the text in place of `/query`; `CommandMenu` hands it to `onInsert`. |
| Open a second list | `next: { label, items }` | The same popover shows the second list, such as people or tags. `label` names it and is its search hint. |

Further fields:

| Field | Purpose |
| --- | --- |
| `group` | Heading above the entry. Entries of one group stand together, in the order the groups first appear; entries keep their order. |
| `icon` | Tabler icon class, such as `ti ti-phone`. |
| `leading` | `() => JSX.Element` in place of the icon, such as an avatar or a tag color. A function, so each row gets its own element. |
| `hint` | Quiet text at the end of the row, such as what to type: `/call`. It is searched without its slash. |
| `keywords` | Further words that find the entry, such as `"anruf"` for "Phone call". |
| `disabled` | A one-line reason. The entry stays in the list, greyed, with the reason, and cannot be chosen. |
| `id` | Stable key, only when two entries share group and label. |

`items` of the menu and of a second list is a list, or a function `(query) => CommandItem[]` for a list the
application filters itself, such as a person search.

## Search

A list filters by label, hint, and keywords. Every word of the query must match. Case and accents do not matter, and a
spelled-out umlaut matches too: "zustaendig" and "zustandig" both find "zuständig".

## Keyboard

The focus stays in the search field (in the editor: in the text). The marked entry is the field's active descendant.

| Key | Action |
| --- | --- |
| <kbd>↑</kbd> <kbd>↓</kbd> | Mark the previous or next entry, wrapping. Unavailable entries are marked too, so their reason is heard. |
| <kbd>Home</kbd> <kbd>End</kbd> | Mark the first or last entry. |
| <kbd>Enter</kbd> <kbd>Tab</kbd> | Choose the marked entry. An unavailable entry does nothing. |
| <kbd>Esc</kbd> | Leave a second list; in the first list, close. |
| <kbd>Backspace</kbd> | In an empty field, leave a second list. |

A pointer chooses with a click; the back control above a second list returns to the first.

## Properties

| Property | Type | Purpose |
| --- | --- | --- |
| `items` | `CommandItem[] \| (query) => CommandItem[]` | The entries. |
| `label` | `string` | Names the menu and its first list, such as "Add to message". |
| `search` | `string` | Names the search field and is its hint. A second list shows its own label there. |
| `onInsert` | `(text: string) => void` | Receives the `text` of a chosen entry. Give it when the entries contain snippets. |
| `position`, `align` | as `Dropdown` | Where the menu opens beside its trigger. |
| `openAt` | as `Dropdown` | Opens the menu beside an anchor without a trigger. |
| `attach` | as `Dropdown` | Adopts a server-rendered element as the trigger. |
| `onOpenChange`, `disabled`, `class` | | As `Dropdown`. |

Place `CommandMenu.Trigger` inside; it takes the props of `Dropdown.Trigger`.

## Layout and states

- The menu is 20rem wide and keeps that width while the query changes and for a second list.
- A query without matches shows "No results"; a polite status says how many entries match.
- Rows use the menu rows of `Dropdown`, 44 px tall on touch devices. On a phone the menu stays inside the viewport,
  and its field uses 16 px text so the page does not zoom.

## Accessibility

The field is a combobox that controls a list box. Groups are labeled by their heading. An unavailable entry has
`aria-disabled="true"` and its reason in its name. The hint and the leading element are hidden from assistive
technology; the label names the entry.

## Runtime

`CommandMenu` is interactive and requires browser code. The surrounding page can remain server rendered; the trigger
renders on the server.

## Example

```tsx
const commands: CommandItem[] = [
  { group: "Kind", label: "Phone call", hint: "/call", icon: "ti ti-phone", keywords: ["anruf"], onSelect: () => setKind("call") },
  { group: "Kind", label: "Confirm appointment", icon: "ti ti-calendar-check", disabled: "Only with an announcement", onSelect: confirm },
  { group: "Snippets", label: "Photos requested", icon: "ti ti-template", text: "Could you send us a few photos?" },
  {
    group: "Actions",
    label: "Assign",
    icon: "ti ti-user-plus",
    next: {
      label: "Search person",
      items: people.map((person) => ({
        label: person.name,
        leading: () => <Avatar name={person.name} size="xs" />,
        onSelect: () => assign(person),
      })),
    },
  },
];

<MarkdownEditor variant="embedded" noToolbar value={text()} onValueChange={setText} commands={commands} />

<CommandMenu items={commands} label="Add to message" search="Search commands" onInsert={insertAtCaret}>
  <CommandMenu.Trigger iconOnly label="Add">
    <i class="ti ti-plus" aria-hidden="true" />
  </CommandMenu.Trigger>
</CommandMenu>
```
