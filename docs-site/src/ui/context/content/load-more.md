# LoadMore

`LoadMore` is the edge of a list that loads more items as the reader nears
it: one row of the same height that reads "Load more" while idle, "Loading
more…" while a page loads, and the error with "Try again" after a failed page.
The list around it never moves when its state changes. Once nothing more is
left, the edge takes no space.

`DataTable`, `Discussion.List`, and `VirtualFeed` with `anchor="start"` use
it for their own end. Use it directly for a list of your own, such as a grid
of cards or a custom row layout, instead of an own observer and button.

The application owns paging: what the next page is, how it loads, and
appending it. The edge owns when to ask, the busy, error, and retry states,
and the button that every reader can use.

## Import

```tsx
import { LoadMore, type LoadMoreProps } from "@k2b/ui";
```

## Use LoadMore

Place `<LoadMore>` right after the list, in the element that also holds the
list, so the edge sees the list grow. Pass `hasMore` and `onLoadMore`.

- The edge asks for the next page by itself when it comes within about
  240 px of the visible area, in its own scroll area or in the window, also
  when a wide table is scrolled sideways. It asks once per approach.
- A page that arrives while the edge is still in reach asks for the next one,
  so a short list fills the view. A page that brought nothing waits until the
  reader leaves the edge and comes back, so an owner that keeps answering empty
  pages is never asked in a loop. Pass the number of loaded items as `count`;
  without it, the edge judges by whether the list grew in its parent element,
  which misses rows that fit into space a list already takes, such as a table
  that fills its height.
- Return a promise from `onLoadMore` to let the edge show its busy state until
  it settles. A rejection shows the error's message, or `errorLabel`, with
  "Try again"; the edge then waits for the reader instead of retrying. Resolve
  to `false` when you declined to load, for example while the first page is
  still loading.
- Owners that track the request themselves pass `loading`. The edge asks
  again once `loading` turns off and the list grew. Pass `error` for a failure
  the owner shows through the edge.
- `auto={false}` leaves the timing to the owner, as `VirtualFeed` does; the
  button stays.
- `side="start"` is the edge above a list whose earlier items load on top, as
  in `Discussion.List`.

Change the texts with `label`, `loadingLabel`, and `errorLabel`. The button
keeps its element in every state, so focus stays on it while a page loads
and after a failure.

## Accessibility

The edge is a real button in every state, so keyboard and screen reader users
can load more without scrolling. While a page loads, the button is
`aria-disabled` and reads "Loading more…"; it keeps focus. An error is a
`role="alert"` next to the button. Mark the list itself `aria-busy` while a
page loads; `VirtualFeed` and `Discussion.List` do so.

## Runtime

The server renders the edge in its idle state, so the first picture already
reserves its row. The observer starts in the browser; without
`IntersectionObserver`, the button alone loads more.

## Example

```tsx
const [cards, setCards] = createSignal(firstPage.items);
const [cursor, setCursor] = createSignal(firstPage.nextCursor);

<div class="receipt-grid">
  <For each={cards()}>{(card) => <ReceiptCard card={card} />}</For>
</div>
<LoadMore
  hasMore={Boolean(cursor())}
  onLoadMore={async () => {
    const page = await loadReceipts(cursor());
    setCards((current) => [...current, ...page.items]);
    setCursor(page.nextCursor);
  }}
/>;
```
