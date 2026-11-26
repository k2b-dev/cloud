### A v2 button with a count had only its number as its name

- **What happened:** In Spaces (W2), the comment button showed a symbol and "2". Its `label` "2 offene Kommentare" reached neither its accessible name nor its hint, so assistive technology read the button as "2".
- **Root cause:** `Button` used `label` only for a button without words. Beside any content, the label was dropped, although its documentation said that it names the button where the words alone do not. The buttons of `Menu` and `Popover` did the same.
- **Error class:** A prop that is documented for a case the code never reaches. The type allowed `label` beside children, but no test rendered that combination.
- **Guard:** The three buttons now follow one rule. Words are the name, and a label beside them is a hint (`title`). A count or a symbol is named by the label, which holds what shows. `packages/ui/src/v2/server-markup.test.ts` renders an icon with a count, words with a label, and a symbol alone for `Button`, and a count with a label for `Menu` and `Popover`, and checks the name of each.
