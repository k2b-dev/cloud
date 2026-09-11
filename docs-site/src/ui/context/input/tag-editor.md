# Tag editing

`Tag`, `TagEditor`, and `MultiSelectInput` separate presentation, entity management, and assignment.

## Use tag editing

Use `TagEditor` for managed tag entities with stable ids. Use `MultiSelectInput` to assign existing ids. Keep `TagsInput` for a freeform comma-separated string list.

## Import

```tsx
import { MultiSelectInput, Tag, TagEditor, type TagEditorItem } from "@k2b/ui";
```

## Ownership

`Tag` owns compact passive and selected presentation. Set `selected` when the
surrounding control represents the current value; the selected treatment uses
a stronger surface, label weight, and a check, so it does not depend on color
alone. Passing either `true` or `false` reserves the same icon slot and keeps
the tag geometry stable while selection changes. Without `onRemove`, the tag is passive: the surrounding link or button owns
`href`, activation, `aria-current`, or `aria-pressed`. With `onRemove`, Tag owns
its remove button; do not nest it inside another interactive control.

`TagEditor` is controlled and backend-free. It owns create/edit/delete interaction, busy state, focus, and inline errors. The application owns persistence, authorization, uniqueness, confirmation, toasts, sorting, and reconciliation. A rejected async callback keeps the editor open. A missing callback hides that capability.

Use `onDirtyChange` when a surrounding settings surface guards navigation or
closing. It reports whether the currently open create or edit form differs from
its initial value and returns to `false` after save, cancel, or cleanup. It does
not report pending persistence or compare the controlled `items` collection.

`MultiSelectInput` accepts `renderOption` and `renderValue` for richer labels while retaining the package-owned selection and removal semantics.

## API reference

```ts
type TagProps = {
  children: JSX.Element; color?: string | null; icon?: string; size?: TagSize; selected?: boolean;
  onRemove?: () => void; removeLabel?: string; disabled?: boolean; class?: string;
};

type TagEditorItem = {
  id: string; name: string; color?: string | null;
};

type TagEditorValue = {
  name: string; color: string;
};

type TagEditorLabels = {
  create: string; empty: string; name: string; namePlaceholder: string; color: string; save: string;
  cancel: string; edit: string; remove: string;
};

type TagEditorProps<T extends TagEditorItem = TagEditorItem> = {
  items: readonly T[]; onCreate?: (value: TagEditorValue) => void | Promise<void>;
  onUpdate?: (item: T, value: TagEditorValue) => void | Promise<void>;
  onDelete?: (item: T) => void | Promise<void>; labels?: Partial<TagEditorLabels>; defaultColor?: string;
  disabled?: boolean; onDirtyChange?: (dirty: boolean) => void; class?: string;
};
```

`TagSize` is `"sm" | "md" | "lg"` (default `"md"`). A tag with `onRemove` includes a remove button; use `removeLabel` to name it. Do not put that interactive tag inside another button. `TagEditor.defaultColor` is `"#6b7280"`. Missing mutation callbacks omit their controls. The host replaces `items` after successful persistence.

## Accessibility

Edit and delete buttons name the affected tag. Forms use the common field contract and announce errors. Do not rely on tag color alone; keep a readable name.

## Runtime

Interactive editing and selection require hydration. The initial list and tags render on the server.

## Example

```tsx
<Tag color="#2563eb" icon="ti ti-point" selected size="lg">
  Platform
</Tag>

<TagEditor
  items={tags()}
  onCreate={createTag}
  onUpdate={updateTag}
  onDelete={async (tag) => {
    if (await confirmDelete(tag)) await deleteTag(tag);
  }}
  onDirtyChange={setTagEditorDirty}
/>

<MultiSelectInput
  label="Assigned tags"
  value={tagIds}
  onValueChange={setTagIds}
  options={tags().map((tag) => ({ value: tag.id, label: tag.name, color: tag.color }))}
/>
```
