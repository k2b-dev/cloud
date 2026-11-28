# States and notices

What a place shows when its data is not simply there: nothing yet, nothing behind a filter, still loading, failed to load. Each state stands where the data will stand, with one way out, and nothing above it moves. A `Notice` says what a person must know or do.

## Reference look

No example meets the reference look yet; build to the rules R1–R13 in `references/look.md` of the skill `k2b-ui`.

## Empty, failed or notice?

### Empty

- The data loaded, and there is nothing (yet), or nothing that matches the filter.
- One sentence and one way out.
- A place that holds nothing because something went wrong or waits, and that cannot be loaded again from there, such as an error page: `tone="bad"` or `tone="warn"` colours its sign. It shows no retry; that is `Failed`.

### Failed

- Data that failed to load once, in the place of that data.
- Its sentence says what stays as it is; its button loads again.

### Notice

- Something a person must know or do while the page works on: a device that does not answer, a conflict, a waiting approval.
- It names the deed ("Schlüssel prüfen"); `tone` says what it is: `bad`, `warn`, `note` or `ai`.

## Parts

Each part in one line. Props are generated from the types of `@k2b/ui/v2`, so this list cannot fall behind the code.

### Empty

Nothing to show (yet): a round sign, one sentence, the one way out.

<Props of="Empty" />

### Loading

Placeholder rows where the list will stand, as high as the rows that will come.

<Props of="Loading" />

### Failed

Data that failed to load once, with "Erneut versuchen" in the language of the page.

<Props of="Failed" />

### Notice

A band with a sign, a sentence and its consequence, and at most two deeds; a deed that cannot be taken now is `disabled`, and the sentence says why.

<Props of="Notice" />

## Not in v2 yet

A placeholder for content that is no list, such as `Facts` or `Cells`: `Loading` draws rows only. Until it ships, use `Loading` with the lines that come closest, and write `// k2b-ui gap: loading facts` at that place.

## Do and don't

### Do

- Put the state where the data will stand, inside the same `Pane`.
- Give `Loading` the number of rows that usually come.
- Say in the status row that a connection retries on its own.
- Name the deed in a `Notice`: "Schlüssel prüfen", not "Mehr erfahren".

### Don't

- Put a box, a frame or a big picture around a state.
- Put "Erneut versuchen" for data that failed to load anywhere but `Failed`.
- Show a toast for a problem that stays at a place.
- Use one sentence for "nothing yet" and "nothing behind this filter".

## Next

[Content](/en/ui/v2/content)
