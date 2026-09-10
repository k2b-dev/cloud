# Notices and inline guidance

`NoticeCard` keeps an important finding visible between an ephemeral toast and a full empty or error state. `NoticeCard.Grid` arranges several findings without nested card chrome.

`InlineGuidance` explains one local prerequisite, consequence, or recovery step without adding a card surface. Use it beside the affected control when a section or field description cannot explain the current state on its own.

## Use notices

Use `neutral` for general notes, `info` for contextual information, `success` for a completed outcome, `warning` for reviewable risk, and `danger` for a real failure. Keep the title specific and the detail actionable.

Use a toast for short confirmation. Use `Placeholder` when the finding replaces an entire content region.

Use `InlineGuidance` for small state-specific copy such as why an action is disabled or what the user must configure next. Prefer hiding an irrelevant control over explaining it, and do not repeat static section or field descriptions as guidance.

## Import

```tsx
import { ButtonLink, InlineGuidance, NoticeCard } from "@k2b/ui";
```

## Composition

`NoticeCard` accepts `title`, optional `detail`, `tone`, `icon`, and `class`.
`NoticeCard.Grid` receives an `items` array and a child renderer. It selects
one, two, or three responsive columns from the item count.

The component owns presentation only. Put retry, dismissal, and navigation controls beside the notice when they are needed.

`InlineGuidance` accepts `children`, an optional `tone`, and an optional icon. It is borderless and has no default icon unless `loading` is true. Its tones use the shared `neutral`, `info`, `success`, `warning`, and `danger` vocabulary. Put a native link or `ButtonLink variant="text"` inside the guidance when a real next step exists.

### Inline loading and feedback

Use `loading` for a short progress message beside a control. It supplies a
spinner and a subtle text shimmer. The application owns when loading starts
and ends; the component adds no delay. Use plain text for loading messages.
A custom `icon` overrides the spinner; `icon={false}` hides it.
Reduced-motion and forced-color preferences disable both animations and retain
readable text. Other tones keep their existing appearance and explicit icons.

```tsx
<InlineGuidance loading>Loading templates…</InlineGuidance>
<InlineGuidance tone="info" icon="ti ti-info-circle">Your content stays unchanged.</InlineGuidance>
<InlineGuidance tone="success" icon="ti ti-circle-check">Template linked.</InlineGuidance>
<InlineGuidance tone="danger" icon="ti ti-alert-circle">Templates could not be loaded.</InlineGuidance>
```

### Render outside Solid

```ts
import { NOTICE_CARD_CLASSES, NOTICE_CARD_ICONS } from "@k2b/ui";
```

Use `NOTICE_CARD_CLASSES` and `NOTICE_CARD_ICONS` only when a renderer cannot
mount the Solid component, such as a server-side Markdown extension or an
editor node view. They expose the same markup classes and default tone icons so
those renderers can preserve the `NoticeCard` contract. Normal Solid code
should render `NoticeCard` instead of assembling its internal markup.

## Accessibility

Notice cards add no live-region role. If a new error notice must be announced immediately, the owning application must provide the appropriate alert semantics. All tones keep visible text, so the result never depends on color or icon.

Inline guidance adds `role="status"`, `aria-live="polite"`, and `aria-busy="true"`
while loading. Without loading it adds no live-region role. Explicit HTML
attributes can override these defaults. A danger tone must still name the problem in text; color is not enough. Add `role="alert"` only when a newly appearing error needs immediate announcement.

Action labels must say what happens next, such as **Retry** or **Open settings**.

## Runtime

Notice content renders on the server. Actions require hydration only when implemented as client callbacks.

## Example

```tsx
const notices = [
  { tone: "neutral", title: "Release note", detail: "Version 2.4 is available." },
  { tone: "info", title: "Import ready", detail: "Twelve records were validated." },
  { tone: "success", title: "Import complete", detail: "Twelve records were created." },
  { tone: "warning", title: "Review needed", detail: "Two records have no owner." },
  { tone: "danger", title: "Source unavailable", detail: "Retrying in the background." },
] as const;

<NoticeCard.Grid items={notices}>
  {(notice) => <NoticeCard {...notice} />}
</NoticeCard.Grid>

<InlineGuidance tone="danger">
  No delivery provider is connected.{" "}
  <ButtonLink variant="text" size="xs" href="/settings/providers">
    Open settings
  </ButtonLink>
</InlineGuidance>
```
