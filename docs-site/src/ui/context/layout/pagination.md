# Pagination

`Pagination` renders previous, next, and numbered links for an SSR result set. The URL remains the source of truth.

## Use Pagination

Use it when the server returns a known page number and total page count.

Use an infinite-load control only when the product does not need stable page URLs. Do not paginate a partial server result in the browser.

## Import

```tsx
import { Pagination } from "@k2b/ui";
```

## Build page URLs

Pass the current page, total pages, and a `baseUrl` that ends immediately before the page number.

```tsx
<Pagination
  currentPage={page}
  totalPages={pageCount}
  baseUrl="/app/inventory?status=open&page="
/>
```

The component concatenates each page number to `baseUrl`. Build the base URL from the current filter state so changing pages does not remove search, sorting, or filters.

The component renders nothing when `totalPages` is one or less. It shows the first page, last page, current page, and adjacent pages with compact gaps.

## Enhanced navigation

Omit `onNavigate` for ordinary document navigation.

Pass `onNavigate` only when the owning island can load and render the selected page. The links still have real URLs and scroll to the top after enhanced navigation.

## Accessibility

The component renders a `Pagination` navigation landmark. Previous, next, and page links have accessible labels. The current page uses `aria-current="page"` and is not a link.

The server must clamp or reject invalid page numbers before rendering the component.

## Runtime

Pagination renders fully during SSR and works without JavaScript.

With `onNavigate`, link enhancement requires hydration. The server route remains the reload and fallback path.

## Example

```tsx typecheck
import { Pagination } from "@k2b/ui";

export function InventoryPagination(props: {
  url: string;
  page: number;
  totalPages: number;
}) {
  const baseUrl = () => {
    const url = new URL(props.url);
    const query = new URLSearchParams(url.searchParams);
    query.delete("page");
    query.append("page", "");
    return `${url.pathname}?${query.toString()}`;
  };
  return <Pagination currentPage={props.page} totalPages={props.totalPages} baseUrl={baseUrl()} />;
}
```
