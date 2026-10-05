# Notices and inline guidance

`NoticeCard` keeps an important finding visible between an ephemeral toast and a full empty or error state. `NoticeCard.Grid` arranges several findings without nested card chrome.

`InlineGuidance` explains one local prerequisite, consequence, or recovery step without adding a card surface. Use it beside the affected control when a section or field description cannot explain the current state on its own.

## Use notices

Use `neutral` (the default) for general notes and explanations, `info` for
contextual information, `success` for a completed outcome, `warning` for
reviewable risk, and `danger` for a real failure. Set a tone only when the
notice means it; an explanation stays neutral.

Write the notice so the words carry the meaning: a specific title, then what
happened and what happens next. Color only supports the words.

Use a toast for short confirmation. Use `Placeholder` when the finding replaces an entire content region.

Use `InlineGuidance` for small state-specific copy such as why an action is disabled or what the user must configure next. Prefer hiding an irrelevant control over explaining it, and do not repeat static section or field descriptions as guidance.

## Import

```tsx
import { ButtonLink, InlineGuidance, NoticeCard } from "@k2b/ui";
```

## Composition

`NoticeCard` accepts `title`, optional `detail`, optional `meta`, `tone`,
`class`, and `bodyClass`. Children render below the title and detail, for
example a list or the controls for the next step. Without a title, the
children are the whole notice.

`meta` is one short fact shown as a small pill at the end of the title row,
such as a deadline (`Due 22 Nov`) or a count. It uses the tone color on a
lighter tint and wraps below the title on narrow screens. It needs a title;
keep anything longer in `detail`.

```tsx
<NoticeCard tone="warning" title="Submit your request" meta="Due 22 Nov" detail="Late requests are planned automatically." />
```

`NoticeCard.Grid` receives an `items` array and a child renderer. It selects
one, two, or three responsive columns from the item count.

A notice is calm by design: a light tint of its tone, no border, a generous
radius and padding, and no icon. The title is semibold in the primary text
color; detail and body use the secondary text color at the normal 14 px
reading size. Only the `meta` pill repeats the tone color. There is one
appearance for every tone and every application; do not add icons or color
the text to make a notice louder. If something needs more weight, say so in
the title.

The tint alone separates a notice from its host, so it does not read as a
second box inside a section, panel, or dialog. Place it directly in the
host's content flow instead of wrapping it in `Paper` or another card, and do
not put a notice inside another notice. Tones use the shared
`--k2b-<tone>-surface` and `--k2b-<tone>-text` tokens; dark mode uses a
lighter share of the tone surface so notices stay calm. The neutral tone is a
translucent tint that stays visible on white and muted surfaces. In
forced-colors mode a system border outlines every notice.

Controls for the next step, such as **Retry** or **Open settings**, can sit
in the notice body below the text. Keep them to one row of buttons.

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
import { NOTICE_CARD_CLASSES } from "@k2b/ui";
```

Use `NOTICE_CARD_CLASSES` only when a renderer cannot mount the Solid
component, such as a server-side Markdown extension or an editor node view.
It exposes the same markup classes so those renderers produce the same calm
notice: a root with `data-tone`, an optional title, and a body. Normal Solid
code should render `NoticeCard` instead of assembling its internal markup.
Markdown callouts (`:::note`, `:::info`, `:::success`, `:::warning`,
`:::danger`) use exactly this contract everywhere they render.

## Accessibility

Notice cards add no live-region role. If a new error notice must be announced immediately, the owning application must provide the appropriate alert semantics. The tint is never the only signal: the title, the body, or the `meta` pill must name the state in words, such as **Could not save** or **Due 22 Nov**. Body text keeps the secondary text color on every tint, so it meets contrast in light and dark mode.

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
  { tone: "warning", title: "Review needed", meta: "Due Friday", detail: "Two records have no owner. They are published once someone owns them." },
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
