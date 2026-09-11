# TagsInput

`TagsInput` edits a controlled list of short text values. The parent owns the tags, validation, and persistence.

## Use TagsInput

Use it when people enter a small set of free-form labels.

Use a select component when values must come from a fixed catalogue.

## Import

```tsx
import { TagsInput } from "@k2b/ui";
```

## State and input

Pass the current `string[]` directly or through a Solid accessor. Adding or
removing tags reports the complete next array live through `onValueChange`.
Blur or Enter reports the normalized final array once through `onValueCommit`.

The editor accepts comma-separated text. It commits on blur or Enter, trims and collapses whitespace, removes empty entries, and removes exact duplicates.

Relevant properties are `label`, `description`, `placeholder`, `value`,
`onValueChange`, `onValueCommit`, `maxTags`, reactive `error`, `required`, and
`disabled`.

## API reference

See [shared field props](/en/ui/getting-started#shared-field-props) for `FieldProps`, `ValueFieldProps<T>` and `MaybeAccessor<T>`.

```ts
type TagsInputProps = ValueFieldProps<string[]> & {
  placeholder?: string; icon?: string; activeIcon?: string; maxTags?: number; name?: string;
};
```

`maxTags` limits the parsed list after trimming and deduplication. Omit it for no count limit. `icon` defaults to `"ti ti-tag"` and `activeIcon` to `"ti ti-pencil"`.

## Accessibility

Provide `label` for a visible field name. Without one, the placeholder becomes the accessible name.

Descriptions and reactive errors are connected to the editable field. Added and removed tags are announced through a polite live region.

## Runtime

`TagsInput` uses a native text field. Its complete initial value renders on the
server; live editing and commit callbacks require hydrated Solid client code.

## Example

```tsx
const [tags, setTags] = createSignal(["backend", "ui"]);

<TagsInput
  label="Labels"
  placeholder="Add tags separated by commas"
  value={tags}
  onValueChange={setTags}
/>;
```
