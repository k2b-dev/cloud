### A v2 head ran past the window on the phone: a button in its start could not shorten, and its end had no fold

- **What happened:** In Notebooks' book head at 390 px, the button "1.000 Kommentare" in the bar's start ended 8 px past the edge. Once every head control stayed visible on the phone (#4373), a head with tabs and six kept actions had no room, and its end could not fold the actions that did not fit. The first fold gave way in the wrong order: the title shrank to 0 px before an action folded.
- **Root cause:** Every child of a bar's start was `flex: none`, so only `Text` and `Inline` could shorten; a button kept its whole width. The bar's end had no way to give way except hiding actions without `keep` on the phone. Nothing said in which order the start and the end give way, or how far.
- **Error class:** A part that may grow (a count in words, one more action) in a place of fixed width, without one rule for what gives way first and where it stops.
- **Guard:** The rule: the start keeps a least (its name at 120 px, or its open tab), the end folds first, and only then the start shortens, down to its least. `packages/ui/src/v2/bar-fold.browser.test.ts` checks it in both engines:
  - at 390 px, a head with tabs, six kept actions and a primary folds its last actions into "…" in their order, and the primary and the whole start stay;
  - the server's page at 390 px already shows the open tab and the name, and at load only buttons turn into "…";
  - an open menu in the end folds nothing more;
  - a folded entry follows its button's pressed and disabled state;
  - the focus of a button that folds goes to "…";
  - every 8 px from 320 to 1440 px, the end ends inside the bar's content edge;
  - an end that ends with its own "…" takes the folded buttons as its first section.
  It failed first on main.
