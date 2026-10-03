# DetailPanel

`DetailPanel` gives contextual inspectors one quiet content structure without
owning their surrounding drawer, workspace region, dialog, or domain state.

`DetailPanel.Body` automatically fades its top and bottom edges while content
remains beyond that edge. Header and footer controls stay outside the fade.
Set `scrollFade={false}` to disable it. The hint follows resize and live content
changes, reserves no space, and is disabled in forced-color mode.

## Import

```tsx
import { DescriptionList, DetailPanel, NumberInput } from "@k2b/ui";
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
set of prominent commands below the identity row. On touch devices, primary
actions keep 0.625rem from the identity row and between wrapped lines, so
their [tap areas](/en/ui/actions/buttons#touch-targets) stay clear of a
`meta` action or the line above. Optional
metadata sits beside the subtitle instead of competing with the title; plain
text in `meta` uses the subtitle's size and color, while badges and buttons keep
their own.
`DetailPanel.Body` is the single scrolling element and accepts a
`scrollPreserveKey`. Its stable scrollbar gutter prevents content from shifting
when expanding content first makes the panel overflow. Inside
`AppWorkspace.Detail`, that gutter occupies the host's existing trailing inset
instead of adding a second gap. On a device whose primary pointer is coarse,
which usually draws overlay scrollbars that reserve no gutter, the panel keeps
the host inset instead, so its content has the same margin on both sides. The
pointer only stands in for the scrollbar style: a touch device with classic
scrollbars shows the gutter next to the inset, and a desktop with overlay
scrollbars keeps the panel at the trailing edge. Do not add a second
full-height scroller inside it.

Use `DetailPanel.Summary` once, directly below the header, when the selected
item has a primary set of facts or controls. Summary and grouped sections share
the same normal surface, while their structure still distinguishes the
primary overview from related context. Do not repeat the summary for every
group.

The panel uses `--k2b-detail-panel-accent` for restrained identity and action
accents, with the portable UI accent as its fallback. A host may map that hook
to its own theme token; `DetailPanel` does not know how the host derives it.

`DetailPanel.Section` draws no frame of its own. It groups content through
spacing and a sentence-case title, not a card, divider, or decorative
background; the group or the body frames it. Pass `icon` for a fixed section icon slot and `tone` to distinguish
portable `accent`, `neutral`, `success`, `warning`, or `danger` roles through
text color only. Pass `description` for short supporting context, `meta` for a
count or state, and `actions` for a normal section. Only the description is
muted: a field in `actions` keeps its own description and error styles. A normal section may omit
its body to represent a compact, actionable empty group. Set `collapsible` for
secondary content. Closed sections show a compact action row; open sections show
a heading with a collapse button on the right. Both states share one geometry
with the other section headings: the icon, title, meta, and chevron keep their
columns and the row its height when the section opens or closes. Hover only
colors the title and chevron, and the row gets no fill. Keyboard focus adds the
shared focus ring, drawn inside the row where the panel would clip it. Their
content stays mounted when
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
same quiet surface as the summary, without a border or lines between its
sections: spacing and the section headings separate them. Pass `label` when the
shared context benefits from an accessible group name.

Every block in the body has one flat frame. A section placed directly in
`DetailPanel.Body` is a group of one: it gets the group surface and inset, so
its icon, title, count, and content start in the same columns as every grouped
section. A [`Discussion`](/en/ui/layout/discussion) inside the panel does the
same. Do not wrap a standalone section in a group only to frame it, and do not
add an application frame, border, or padding around a section. Give every
section of a panel an `icon` so the titles share one column.

Sections accept arbitrary content. Use `DescriptionList layout="rows"` for
compact properties. When people edit those properties in place, make them
[property rows](/en/ui/surfaces/details#property-rows): a control with
`appearance="plain"` as the row's value shows the value as text, and the whole
row opens its picker. Keep the summary's pencil action for the full edit form.
Use normal shared inputs for a full form inspector, and the
appropriate shared list, table, notice, preview, or editor for specialized
content. Use [`Discussion`](/en/ui/layout/discussion) directly in the body when
notes or comments need their own labelled composer and author timeline. It
takes the frame and heading of a section, so it needs no group or wrapper. Rows
that are not `DetailPanel.Action`, such as a static address or an empty
message, start at the content edge without their own horizontal padding. A
left-aligned `Placeholder` in a section does the same on its own. Do not
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
data, comments, history, or form fields. Stacked action rows sit flush, so on
touch devices each row is at least 44 px (2.75rem) tall, including its
secondary and Dots buttons, and its tap area keeps the row height instead of
reaching into the neighbouring row. This follows the device, not the input in
use: a laptop with a touch screen gets the taller rows with a mouse too, and
devices without a touch screen keep the compact rows.

When one secondary command is frequent enough to deserve a direct control, such
as deleting an attachment, pass `secondaryAction` with an `icon`, an accessible
`label`, and `onClick`. Name the label after the row, such as
`Delete budget.xlsx`, so repeated buttons stay distinguishable. It renders as a
sibling icon button at the end of the row, before an optional Dots trigger, and
follows the same reveal: hover or keyboard focus on fine pointers, always
visible on touch devices. Set `variant: "danger"` for a destructive command;
hover and focus then use the danger text color. The button only reports the
click. The application confirms destructive work, performs it, and refreshes
the list. When that removes the focused row, the application moves focus to
the row that takes its place. Keep further commands in `menuItems`.

## API reference

```ts
type DetailPanelProps = {
  children: JSX.Element; class?: string;
};

type DetailPanelHeaderBaseProps = {
  title: JSX.Element; subtitle?: JSX.Element; meta?: JSX.Element; actions?: JSX.Element;
  primaryActions?: JSX.Element; class?: string;
};

type DetailPanelHeaderProps = DetailPanelHeaderBaseProps &
  (
    | {
        leading?: JSX.Element;
        icon?: never;
      }
    | {
        leading?: never;
        icon?: string;
      }
  );

type DetailPanelBodyProps = {
  children: JSX.Element; scrollPreserveKey?: string; scrollFade?: boolean; class?: string;
};

type DetailPanelSummaryProps = {
  title: JSX.Element; children: JSX.Element; actions?: JSX.Element; class?: string;
};

type DetailPanelGroupProps = {
  children: JSX.Element; label?: string; class?: string;
};

type DetailPanelTone = "accent" | "neutral" | "success" | "warning" | "danger";

type DetailPanelSectionBaseProps = {
  title: JSX.Element; icon?: string; tone?: DetailPanelTone; description?: JSX.Element; meta?: JSX.Element;
  class?: string;
};

type DetailPanelSectionProps = DetailPanelSectionBaseProps &
  (
    | {
        children?: JSX.Element;
        actions?: JSX.Element;
        collapsible?: false;
        defaultOpen?: never;
        open?: never;
        onOpenChange?: never;
        disabled?: never;
      }
    | {
        children: JSX.Element;
        actions?: never;
        collapsible: true;
        defaultOpen?: boolean;
        open?: boolean;
        onOpenChange?: (open: boolean) => void;
        disabled?: boolean;
      }
  );

type DetailPanelActionSecondary = {
  icon: string; label: string; onClick: () => void; variant?: "danger";
};

type DetailPanelActionBaseProps = {
  title: JSX.Element; description?: JSX.Element; leading?: JSX.Element; trailing?: JSX.Element;
  secondaryAction?: DetailPanelActionSecondary; class?: string;
};

type DetailPanelActionMenuProps =
  | {
      menuItems?: never;
      menuLabel?: never;
    }
  | {
      menuItems: readonly DropdownItem[];
      menuLabel: string;
    };

type DetailPanelActionLinkProps = DetailPanelActionBaseProps &
  DetailPanelActionMenuProps &
  Omit<ButtonLinkProps, "children" | "class" | "size" | "title" | "variant"> & {
    href: string;
  };

type DetailPanelActionButtonProps = DetailPanelActionBaseProps &
  DetailPanelActionMenuProps &
  Omit<ButtonProps, "children" | "class" | "size" | "title" | "variant"> & {
    href?: never;
  };

type DetailPanelActionProps = DetailPanelActionLinkProps | DetailPanelActionButtonProps;
```

The `*BaseProps` shapes explain shared fields of the public unions. `Header` chooses icon/title or custom leading content through its union; `Action` chooses a menu, link, or native button. `DropdownItem` uses the [menu contract](/en/ui/actions/menus#api-reference); native button/link attributes retain their usual types. Boolean features are off unless enabled; `Body` owns the scroll area by default.

## Accessibility

The header title is an `h2`; normal section titles are labelled `h3` headings.
Decorative header and section icons are hidden from assistive technology, so
their adjacent text remains the label and color is never the only signal.
Collapsible sections use native buttons with expanded state and a relationship
to their content. Focus follows the toggle when its counterpart becomes visible.
Every icon-only action and every control embedded in a description value still
needs its own accessible name. `DetailPanel.Action` keeps its visible title as
the accessible name and renders a real link or button. Its secondary action is a
separate button in the tab order, named by `label`.

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
            {
              term: "Quantity",
              description: (
                <NumberInput aria-label="Quantity" appearance="plain" min={0} value={quantity} onValueCommit={saveQuantity} />
              ),
            },
          ]}
        />
      </DetailPanel.Summary>
      <DetailPanel.Section
        title="Notes"
        icon="ti ti-notes"
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
      <DetailPanel.Section title="History" icon="ti ti-history" collapsible>
        …
      </DetailPanel.Section>
    </DetailPanel.Body>
  </DetailPanel>
</AppWorkspace.Detail>
```
