# DetailPanel

`DetailPanel` gives contextual inspectors one quiet content structure without
owning their surrounding drawer, workspace region, dialog, or domain state.

## Import

```tsx
import { DescriptionList, DetailPanel } from "@k2b/ui";
```

## Use DetailPanel

Place it inside `AppWorkspace.Detail` for persistent selection context, or in
another host when the same inspector content is reused. The host owns opening,
closing, sizing, and persistence. The application owns data, permissions,
mutations, and which sections are present.

`DetailPanel.Header` keeps identity and actions in one compact region. Pass
`icon` for the standard accent-tinted identity tile or `leading` for an avatar
or another custom identity; they are mutually exclusive. Pass `actions` for
compact utilities such as more and close, and `primaryActions` for the small
set of prominent commands below the identity row. Optional metadata sits
beside the subtitle instead of competing with the title.
`DetailPanel.Body` is the single scrolling element and accepts a
`scrollPreserveKey`. Its stable scrollbar gutter prevents content from shifting
when expanding content first makes the panel overflow. Inside
`AppWorkspace.Detail`, that gutter occupies the host's existing trailing inset
instead of adding a second gap. Do not add a second full-height scroller inside
it.

Use `DetailPanel.Summary` once, directly below the header, when the selected
item has a primary set of facts or controls. Summary and grouped sections share
the same normal surface, while their structure still distinguishes the
primary overview from related context. Do not repeat the summary for every
group.

The panel uses `--k2b-detail-panel-accent` for restrained identity and action
accents, with the portable UI accent as its fallback. A host may map that hook
to its own theme token; `DetailPanel` does not know how the host derives it.

`DetailPanel.Section` is deliberately flat by default. It groups content
through spacing and a sentence-case title, not a card, divider, or decorative
background. Pass `icon` for a fixed section icon slot and `tone` to distinguish
portable `accent`, `neutral`, `success`, `warning`, or `danger` roles through
text color only. Pass `description` for short supporting context, `meta` for a
count or state, and `actions` for a normal section. A normal section may omit
its body to represent a compact, actionable empty group. Set `collapsible` for
secondary content. Closed sections show a compact action row; open sections show
a heading with a collapse button on the right. Their content stays mounted when
closed, preserving unsaved input and child state. Collapsible sections reserve
the header action for collapsing.

Use `defaultOpen` for an initially expanded section, or control it with `open`
and `onOpenChange`. Controlled state is authoritative: the callback requests a
change but does not open or close the section itself. This lets an editor open
the relevant section after validation fails. `disabled` disables both toggle
buttons; it does not disable the child controls. Use a fieldset for that.
The content owns its layout: wrap form controls in a column with a gap.

Use `DetailPanel.Group` when one or more sections form one stable context, such
as a company and its contacts or a document and its derived metadata. Merge
adjacent sections when they belong to that same context. The group owns the
same normal surface as the summary and the one-pixel gaps between its sections;
sections outside a group stay flat. Pass `label` when the shared context benefits from an
accessible group name. Do not wrap every standalone section or manufacture
groups only for decoration.

Sections accept arbitrary content. Use `DescriptionList layout="rows"` for
compact properties, normal shared inputs for a full form inspector, and the
appropriate shared list, table, notice, preview, or editor for specialized
content. Use [`Discussion`](/en/ui/layout/discussion) directly in the body when
notes or comments need their own labelled composer and author timeline. Do not
add domain variants such as `record`, `mail`, or `workflow` to `DetailPanel`.

Use `DetailPanel.Action` for a full-width destination or command such as a
related record, attachment, or in-panel jump. Pass `href` for native link
semantics; omit it for a native button. `leading`, `title`, optional
`description`, and `trailing` keep row geometry and interaction states
consistent. Action rows align their optional leading icon with the section
heading and keep their default label as quiet as supporting text. Hover and
keyboard focus change only the action text and icon to the panel's primary
color; the row and optional Dots menu trigger stay transparent. When a
destination has secondary actions, pass declarative
`menuItems` together with the required accessible `menuLabel`. The primary link
and the Dots trigger render as sibling controls, so the whole main row remains
a native destination without nesting a button inside the link. On fine-pointer
devices the Dots trigger appears on row hover, keyboard focus, or while its menu
is open; it remains visible on touch devices. Do not use it for static key-value
data, comments, history, or form fields.

## Accessibility

The header title is an `h2`; normal section titles are labelled `h3` headings.
Decorative header and section icons are hidden from assistive technology, so
their adjacent text remains the label and color is never the only signal.
Collapsible sections use native buttons with expanded state and a relationship
to their content. Focus follows the toggle when its counterpart becomes visible.
Every icon-only action and every control embedded in a description value still
needs its own accessible name. `DetailPanel.Action` keeps its visible title as
the accessible name and renders a real link or button.

## Runtime

The composition and its initial open state are server-renderable. Toggling a
collapsible section requires hydration. Interactive children keep their own
state and remain mounted when the section closes.

## Example

```tsx
<AppWorkspace.Detail id="item" open={selectedId() !== null} width="md">
  <DetailPanel>
    <DetailPanel.Header
      icon="ti ti-building-warehouse"
      title="Studio shelf"
      subtitle="Locations · version 2"
      primaryActions={<Toolbar label="Location actions"><Button size="xs">Edit</Button></Toolbar>}
      actions={<IconButton label="Close details"><i class="ti ti-x" aria-hidden="true" /></IconButton>}
    />
    <DetailPanel.Body scrollPreserveKey="location-detail">
      <DetailPanel.Summary title="Overview">
        <DescriptionList
          layout="rows"
          size="sm"
          actionVisibility="progressive"
          items={[
            { term: "Room", description: "Studio" },
            { term: "Quantity", description: "18" },
          ]}
        />
      </DetailPanel.Summary>
      <DetailPanel.Section
        title="Notes"
        meta="0"
        description="Keep decisions with this location"
        actions={<Button variant="ghost" size="xs">Add note</Button>}
      />
      <DetailPanel.Group label="Inventory context">
        <DetailPanel.Section title="Related records" icon="ti ti-link" tone="accent">
          <DetailPanel.Action
            href="/app/grids/locations/records/st-02"
            leading={<i class="ti ti-building-warehouse" aria-hidden="true" />}
            title="Studio"
            description="Room · ST-02"
            trailing={<i class="ti ti-chevron-right" aria-hidden="true" />}
          />
        </DetailPanel.Section>
        <DetailPanel.Section title="Attachments" icon="ti ti-paperclip" tone="neutral" meta="2" />
      </DetailPanel.Group>
      <DetailPanel.Section title="History" collapsible>
        …
      </DetailPanel.Section>
    </DetailPanel.Body>
  </DetailPanel>
</AppWorkspace.Detail>
```
