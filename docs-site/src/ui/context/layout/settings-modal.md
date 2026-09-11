# Settings

`SettingsPage` is the flat shell for a dedicated settings route. It owns one
page heading, a scrolling content region, optional header actions, and an
optional fixed footer. It deliberately adds no outer card or dialog frame.

`SettingsModal` is a portable tabbed settings surface. It owns category
navigation, keyboard behavior, and the active panel. The application owns
loading, form state, validation, persistence, and the surrounding dialog or
page.

## Use SettingsModal

Use `SettingsPage` for a full settings route. Use `SettingsModal` when one
resource has several settings categories. Use `PanelDialog` for an actual
dialog or complex embedded editor and `prompts.form` for a small prompt.

## Import

```tsx
import {
  Button,
  readSettingsError,
  sameSettingValue,
  SettingsCollection,
  SettingsField,
  SettingsGroup,
  SettingsModal,
  SettingsPage,
  SettingsPanelFooter,
  SettingsSaveBar,
  SettingsSection,
  TextInput,
} from "@k2b/ui";
```

## Compose a full settings page

Keep the page flat: place section cards directly in `SettingsPage`, and put
save state in `footer`. Do not wrap a dedicated route in `PanelDialog` merely
to create another outer surface.

```tsx
<SettingsPage
  title="Project settings"
  subtitle="Identity and defaults"
  icon="ti ti-settings"
  actions={<Button variant="secondary">Test connection</Button>}
  footer={<SettingsPanelFooter {...saveState} />}
>
  <SettingsSection title="Identity" icon="ti ti-id">
    <SettingsField {...fieldProps}>…</SettingsField>
  </SettingsSection>
</SettingsPage>
```

`SettingsSection` is the page-level paper surface for a coherent settings
group. It provides one accessible section heading, optional actions, and the
same compact rhythm as Cloud admin data panels. Keep `PanelDialog.Section`
inside dialogs; it intentionally has a different containment contract.

Inside `SettingsModal`, use `SettingsGroup` for a flat form group and
`SettingsCollection` for compact entity management. Neither component owns a
backend or adds another paper inside the modal.

## Compose controlled tabs

Compose categories with `SettingsModal.Tab`. Each tab needs a stable `id`,
title, and children. Wrap related tabs in `SettingsModal.Group` to add a short
rail label without changing tab selection or keyboard order. The category rail
remains visible at narrow widths instead of becoming a separate select.

`activeTab` and `onTabChange` make selection controlled; use `defaultTab` for
local selection. An optional `onClose` adds a close action without deciding how
the surrounding surface is opened.

Place `SettingsModal.Footer` inside a tab when that category has a persistent
status and action row. The modal keeps the footer outside the scrolling panel;
the application still owns dirty state, saving, discarding, and navigation
guards.

Use category titles, descriptions, and icons to provide visible context.

## Compose flat groups and collections

`SettingsGroup` owns one subsection heading, description, named action slot,
and a quiet content rhythm. Use `SettingsGroup.Action` for visual actions
instead of passing JSX through an action prop.

`SettingsCollection` owns one entity-list heading, compact empty state, and
semantic list. Add its primary action through `SettingsCollection.Action`.
Each `SettingsCollection.Item` accepts scalar title and description data; put
visual status and controls in `SettingsCollection.Item.Status` and
`SettingsCollection.Item.Actions`.

Use `SettingsCollection.Item.Reorder` inside the actions slot for an ordered
collection. Pass the current zero-based `index`, total `count`, and an `onMove`
callback. It owns accessible move-up and move-down controls and disables moves
at the collection boundaries. The application still owns the reordered state,
persistence, optimistic updates, rollback, and announcements after a move.

The collection does not create, update, delete, sort, authorize, or confirm
anything. The application supplies those behaviors through the controls it
composes into the named slots. Use a specialized editor such as `TagEditor` or
`PermissionEditor` when that complete interaction already exists.

## Compose form state

`SettingsField` groups a label, required description, reactive error accessor,
optional reactive dirty accessor, and a control. Use its render-function child
and pass `describedBy` to the control's `aria-describedby` so screen readers
announce the visible description and current validation error.

`SettingsSaveBar` uses reactive `changeCount` and `loading` accessors. It
appears only while the count is greater than zero and disables its actions
while loading. Use reactive `saveDisabled` when validation should disable Save
without preventing Discard.

`SettingsPanelFooter` provides the same status and actions for a surrounding
panel footer. It remains visible with `No unsaved changes`, disables both
actions until a change exists, and accepts `saveVariant` for the shared button
hierarchy. It also accepts `saveDisabled` for field validation.

`sameSettingValue` performs the JSON-based, order-sensitive comparison used by
settings forms. `readSettingsError(response, fallback)` reads the shared
`message` and per-field `errors` response shape. These helpers do not perform a
request or select a persistence backend.

## API reference

```ts
type SettingsModalTabTone = "default" | "danger";

type SettingsModalProps = {
  title: string; subtitle?: string; icon?: string; defaultTab?: string; activeTab?: string;
  onTabChange?: (id: string) => void; onClose?: () => void; closeLabel?: string; class?: string;
  children: JSX.Element;
};

type SettingsModalTabProps = {
  id: string; title: string; description?: string; icon?: string; tone?: SettingsModalTabTone;
  children: JSX.Element;
};

type SettingsModalGroupProps = {
  title: string; children: JSX.Element;
};

type SettingsModalFooterProps = {
  children: JSX.Element;
};

```

### Settings content

```ts
type SettingsPageProps = {
  title: JSX.Element; subtitle?: JSX.Element; icon?: string; actions?: JSX.Element; children: JSX.Element;
  footer?: JSX.Element; scrollPreserveKey?: string; class?: string; style?: JSX.CSSProperties | string;
};

type SettingsSectionProps = {
  title: JSX.Element; subtitle?: JSX.Element; icon?: string; actions?: JSX.Element; children: JSX.Element;
  class?: string;
};

type SettingsGroupProps = {
  title: JSX.Element; description?: JSX.Element; children: JSX.Element; class?: string;
};

type SettingsGroupActionProps = {
  children: JSX.Element;
};

type SettingsFieldProps = {
  label: string; description: string; error: MaybeAccessor<string | undefined>;
  changed?: MaybeAccessor<boolean>;
  children: JSX.Element | ((control: SettingsFieldControlProps) => JSX.Element); class?: string;
};

type SettingsFieldControlProps = {
  describedBy: () => string;
};

type SettingsSaveBarProps = {
  changeCount: MaybeAccessor<number>; loading: MaybeAccessor<boolean>; saveDisabled?: MaybeAccessor<boolean>;
  onDiscard: () => void; onSave: () => void; saveLabel?: string; saveVariant?: ButtonVariant; class?: string;
};

type SettingsPanelFooterProps = SettingsSaveBarProps;

```

### Collections

```ts
type SettingsCollectionProps = {
  title: JSX.Element; description?: JSX.Element; empty?: JSX.Element; children?: JSX.Element; class?: string;
};

type SettingsCollectionActionProps = {
  children: JSX.Element;
};

type SettingsCollectionItemProps = {
  title: JSX.Element; description?: JSX.Element; icon?: JSX.Element; children?: JSX.Element;
};

type SettingsCollectionItemStatusProps = {
  children: JSX.Element;
};

type SettingsCollectionItemActionsProps = {
  children: JSX.Element;
};

type SettingsCollectionItemReorderProps = {
  label: string; index: number; count: number; disabled?: boolean; onMove: (direction: -1 | 1) => void;
};
```

`MaybeAccessor<T>` means `T | (() => T)`; use accessors where the types require them. Compound slots correspond to their full prop names, e.g. `SettingsCollection.Item.Reorder`. `DropdownItem` is defined under [menus](/en/ui/actions/menus#api-reference). A SettingsField child must give the actual input an accessible name and forward `describedBy()` to associate its description/error. `SettingsModal.subtitle` and `icon` are compatibility props; use tab descriptions/icons for visible context.

`sameSettingValue(left: unknown, right: unknown): boolean` compares JSON serialization, so use it for JSON-compatible setting values. `readSettingsError(response: Response, fallback: string)` resolves to `{ message: string; fields: Record<string, string> }`, reading `message` and `errors` from response JSON; malformed JSON uses the fallback and empty fields.

## Accessibility

The category rail is a tab list. Group labels are presentational and do not add
keyboard stops. Arrow keys move between all tabs; Home and End move to the
first and last tab across groups. Every tab needs a stable `id` and concise
title. Use `tone="danger"` only for destructive settings.

`SettingsGroup`, `SettingsCollection`, and collection items create their own
heading and list semantics. Visual collection actions still need the
accessible names required by their underlying controls.

Errors render as alerts, and the dirty state includes an explicit `Unsaved`
label rather than relying on color.

## Runtime

The active panel renders on the server. Tab selection, close controls, form
callbacks, and saving require hydrated Solid code.

## Example

```tsx typecheck
import { SettingsField, SettingsGroup, SettingsModal, SettingsSaveBar, TextInput } from "@k2b/ui";
import { createSignal } from "solid-js";

export function ConnectionSettings(props: {
  initialEndpoint: string;
  save: (endpoint: string) => Promise<void>;
}) {
  const [saved, setSaved] = createSignal(props.initialEndpoint);
  const [endpoint, setEndpoint] = createSignal(props.initialEndpoint);
  const [error, setError] = createSignal<string>();
  const [loading, setLoading] = createSignal(false);
  const changed = () => endpoint() !== saved();
  const save = async () => {
    setLoading(true);
    setError(undefined);
    const value = endpoint();
    try {
      await props.save(value);
      setSaved(value);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Save failed");
    } finally {
      setLoading(false);
    }
  };
  return (
    <SettingsModal title="Connection settings">
      <SettingsModal.Tab id="connection" title="Connection">
        <SettingsGroup title="Service">
          <SettingsField label="Endpoint" description="Public service URL" error={error} changed={changed}>
            {({ describedBy }) => <TextInput aria-label="Endpoint"
              aria-describedby={describedBy()} value={endpoint()} onValueChange={setEndpoint}
              disabled={loading()} />}
          </SettingsField>
        </SettingsGroup>
        <SettingsSaveBar changeCount={() => changed() ? 1 : 0} loading={loading}
          onSave={() => void save()} onDiscard={() => { setEndpoint(saved()); setError(undefined); }} />
      </SettingsModal.Tab>
    </SettingsModal>
  );
}
```
