# AppOverview

`AppOverview` is the landing-page shell for an application. It provides the app identity, a primary content column, an optional aside, and a shared empty state.

The application owns search, URL state, cards, creation, and mutations.

## Use AppOverview

Use it when an app opens with a resource collection and a small set of create actions.

Use `AppWorkspace` when the screen needs persistent navigation, contextual detail, drawers, or a fill-height work area.

## Import

```tsx
import {
  AppOverview,
  Button,
  DataPanel,
  LinkCard,
  PanelHeader,
} from "@k2b/ui";
```

## Compose the page

Pass the application `title` and required Tabler `icon` to the root.
`subtitle` is optional and should fit on one line. The root renders the title
and subtitle with `PanelHeader size="lg"`, the same page header as a
sidebar-first overview.

Put the page's single primary action, such as a create button or a create
menu, in `actions`. It sits at the trailing edge of the page header.

Use `AppOverview.Main` for the collection. Its `toolbar` slot suits a search field or one compact filter.

Use `AppOverview.Cards` when the collection is a small set of objects. It lays
out as many columns of at least 19rem as fit and collapses to one column on
narrow screens. Put one `LinkCard` per object in it: a title, one secondary
fact, and at most one trailing count or badge.

Use `AppOverview.Aside` for short supporting content, such as a status or
reference panel. Do not repeat the primary action there.

Use `AppOverview.EmptyState` inside the main collection when there are no matching resources. Put the relevant create or reset action in its children.

The component supplies responsive columns and a maximum page width. Do not wrap it in another page container.

## Frame record collections

Use `DataPanel` around a list or table that needs a title, count, controls,
loading failure, empty state, or footer. Its children remain edge-to-edge so a
table can own row borders and scrolling.

`error` takes precedence over `isEmpty`. Pass a user-facing error string;
`DataPanel` supplies the error presentation. Pass `empty` as the empty-state
description or content.

`PanelHeader` is the title row used by `DataPanel`. Use it directly when
another surface needs the same title, subtitle, and action arrangement. It
does not add a border, background, or divider. Choose `as="h1"`, `"h2"`, or
`"h3"` to preserve the page hierarchy, `size="md"` for a section title, and
`size="lg"` for the page title of a sidebar-first overview.

## API reference

```ts
type AppOverviewProps = {
  title: string; subtitle?: string; icon: string; actions?: JSX.Element; class?: string; children: JSX.Element;
};

type AppOverviewPanelProps = {
  title: string; description?: JSX.Element; toolbar?: JSX.Element; class?: string; children: JSX.Element;
};

type AppOverviewCardsProps = {
  class?: string; children: JSX.Element;
};

type AppOverviewEmptyStateProps = {
  title: string; description?: JSX.Element; icon?: string; class?: string; children?: JSX.Element;
};
```

PanelHeader and DataPanel are shared with the [operational surfaces reference](/en/ui/surfaces/observability#api-reference). Use the compound members for composition and the parent for the page title/action area.

## Accessibility

The root renders the page heading. Main and aside titles render section headings.

Every create card must be a real button or link with a specific label. Empty-state actions must state what they create or reset.

## Runtime

`AppOverview` renders on the server. Interactive search and create controls belong in islands.

Keep shareable search and filter state in the URL. The server should return the matching collection.

`DataPanel` and `PanelHeader` also render on the server. Search controls,
filters, and actions keep their own runtime requirements.

## Example

```tsx
<AppOverview
  title="Notebooks"
  subtitle={`${total} notebooks`}
  icon="ti ti-notebook"
  actions={<Button onClick={createNotebook}>New notebook</Button>}
>
  <AppOverview.Main title="Your notebooks" toolbar={<NotebookSearch value={search} />}>
    {notebooks.length > 0 ? (
      <AppOverview.Cards>
        <For each={notebooks}>
          {(notebook) => (
            <LinkCard
              href={`/app/notebooks/${notebook.id}`}
              title={notebook.name}
              description={notebook.description}
              icon="ti ti-notebook"
              meta={`${notebook.noteCount} notes`}
            />
          )}
        </For>
      </AppOverview.Cards>
    ) : (
      <AppOverview.EmptyState
        title="No notebooks found"
        description="Try a different search."
        icon="ti ti-notebook-off"
      >
        <Button size="sm" variant="secondary" onClick={clearSearch}>
          Clear search
        </Button>
      </AppOverview.EmptyState>
    )}
  </AppOverview.Main>
</AppOverview>
```

```tsx
<DataPanel
  title="Notebooks"
  subtitle={`${visible} of ${total} notebooks`}
  actions={<a href="/app/notebooks/new">New notebook</a>}
  search={<NotebookSearch value={search} />}
  error={loadError}
  isEmpty={notebooks.length === 0}
  empty="No notebooks match the current search."
  footer={<Pagination currentPage={page} totalPages={pages} baseUrl={baseUrl} />}
>
  <NotebookTable notebooks={notebooks} />
</DataPanel>
```
