# Buttons

`Button`, `ButtonLink`, `IconButton`, `IconButtonLink`, and `SplitButton` provide one semantic action hierarchy with consistent focus, sizing, and variants.

## Use Buttons

Use `primary` for the main forward action, `secondary` for supporting actions, `ghost` for quiet toolbar actions, `text` for inline disclosures without a surface or horizontal inset, `subtle` for compact contextual actions, `input` for actions placed directly beside a field, `warning` for time-sensitive or cautionary actions, `danger` for destructive work, and `success` only when success is the action's meaning.

## Import

```tsx
import { Button, ButtonLink, IconButton, IconButtonLink, SplitButton } from "@k2b/ui";
```

## Example

```tsx
<Button variant="primary" loading={saving()} loadingLabel="Saving">
  Save
</Button>

<Button variant="subtle" size="xs">
  <i class="ti ti-activity" aria-hidden="true" /> Status
</Button>

<Button variant="warning" size="xs">Undo send · 8s</Button>

<Button variant="text" size="xs">More</Button>

<IconButton label="Project settings">
  <i class="ti ti-settings" aria-hidden="true" />
</IconButton>

<IconButton label="Add filter" variant="input">
  <i class="ti ti-plus" aria-hidden="true" />
</IconButton>

<ButtonLink href="/settings" variant="secondary">Settings</ButtonLink>

<IconButtonLink href="/settings" label="Open settings">
  <i class="ti ti-external-link" aria-hidden="true" />
</IconButtonLink>

<SplitButton
  onClick={send}
  menuLabel="More send options"
  items={[
    { label: "Save as draft", icon: "ti ti-device-floppy", action: saveDraft },
    { label: "Send later", icon: "ti ti-clock", action: scheduleSend },
  ]}
>
  <i class="ti ti-send" aria-hidden="true" /> Send
</SplitButton>
```

`size` accepts `xs`, `sm`, `md`, or `lg`. `Button` defaults to `primary`; `IconButton` defaults to `ghost`. Loading disables the action, exposes busy semantics, and may replace the visible label through `loadingLabel`.

The `input` variant uses the same height, radius, muted surface, hover border, and inset focus treatment as form fields. Use it for a separate action immediately beside an input, not for actions embedded inside the field shell.

Hover preserves each variant's color hierarchy. Pressing an immediate action adds a subtle inward scale without adding shadow depth or changing layout; a split button's main action moves the compound control, while its menu trigger opens without scaling. Reduced-motion preferences keep the color feedback without the scale.

Use `SplitButton` when one immediate action has closely related alternatives. The main segment remains a native button; the icon-only segment opens the existing `DropdownItem` menu contract. `variant`, `size`, `disabled`, and `loading` apply to both segments. `menuLabel` is required as the secondary trigger's accessible name.

Links use normal document navigation by default. Inside a hydrated SSR workspace, opt into the shared navigation contract explicitly:

```tsx
<ButtonLink href="/items" navigation="enhanced" scroll="preserve" onNavigate={refreshWorkspace}>
  More items
</ButtonLink>
```

Enhanced button links require `onNavigate`; without it they safely retain
native document navigation.

## Accessibility

All matching native button or anchor attributes pass through. The default button `type` is `button`, so form submission stays explicit. `IconButton` and `IconButtonLink` require `label`; `SplitButton` requires `menuLabel`. These labels supply the icon-only control's accessible name and title.

## Runtime

Buttons render complete server HTML. Click and reactive loading behavior require hydration only when their state or handlers are client-owned.
