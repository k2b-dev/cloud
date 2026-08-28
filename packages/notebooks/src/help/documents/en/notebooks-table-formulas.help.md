---
id: notebooks-table-formulas
title: "Table formulas"
icon: "ti ti-math-function"
description: "Complete table formula syntax and function reference."
order: 140
---

Table formulas turn Markdown table cells into computed values. They are intentionally small: write the formula in the cell and keep the source columns visible.

**Formula shape**

## Small examples {icon="flask"}

**Progress**

```text
=PROGRESS(2, 10)
```

**Column total**

```text
=SUM(Hours)
```

**Conditional label**

```text
=IF(Status == "done", "closed", "open")
```

**Syntax**

## Formula rules {icon="ruler-2"}

:::reference
- **Start with =:** A table formula cell starts with =, for example =SUM(Hours).
- **Reference columns by name:** Use the column name directly. Wrap names with spaces in backticks, for example =SUM(`Total Cost`).
- **Comparisons return numbers:** >, <, ==, and related operators return 1 or 0.
- **Formula cells do not count themselves:** Column totals skip their own formula cell, so =SUM(Hours) does not include the total cell.
:::

**Reference**

## Function catalog {icon="book-2"}

### Autocomplete and rendering use this surface

The same function names are used by table autocomplete, edit preview, and read-mode rendering.

### Names are case-insensitive

Use uppercase for readability, but the formula evaluator accepts lower-case function names too.

### Progress and percentages

Use these when a cell should show completion or a percent.

| Function | Syntax | Example | Result and notes |
| --- | --- | --- | --- |
| `PROGRESS` | `PROGRESS(ratio)` | `=PROGRESS(0.4)` | 40% progress bar<br>The visual bar is clamped between 0% and 100%. |
| `PROGRESS` | `PROGRESS(done, total)` | `=PROGRESS(2, 10)` | 2/10 progress bar<br>total must not be 0. |
| `PERCENT` | `PERCENT(part, total)` | `=PERCENT(Done, Total)` | percent number<br>Returns 40 for 40%, not 0.4. |

### Column aggregates

Read one whole column. Empty or non-numeric cells are ignored for numeric functions.

| Function | Syntax | Example | Result and notes |
| --- | --- | --- | --- |
| `SUM` | `SUM(column)` | `=SUM(Hours)` | sum of numeric cells |
| `AVG` | `AVG(column)` | `=AVG(Rating)` | average; 0 when empty |
| `MEAN` | `MEAN(column)` | `=MEAN(Rating)` | same as AVG(column) |
| `MIN` | `MIN(column)` | `=MIN(Price)` | smallest number; 0 when empty |
| `MAX` | `MAX(column)` | `=MAX(Price)` | largest number; 0 when empty |
| `COUNT` | `COUNT(column)` | `=COUNT(Name)` | non-empty cell count<br>Text counts too. |
| `MEDIAN` | `MEDIAN(column)` | `=MEDIAN(Score)` | middle number; 0 when empty |
| `UNIQUE` | `UNIQUE(column)` | `=UNIQUE(Status)` | distinct non-empty value count |
| `STDEV` | `STDEV(column)` | `=STDEV(Weight)` | sample standard deviation<br>Returns 0 for fewer than 2 numbers. |
| `COUNTIF` | `COUNTIF(column, value)` | `=COUNTIF(Status, "done")` | matching cell count<br>Exact string match. |
| `SUMIF` | `SUMIF(sumColumn, conditionColumn, value)` | `=SUMIF(Hours, Status, "done")` | conditional sum |

### Row aggregates

Read the current row. The cell containing the formula is skipped.

| Function | Syntax | Example | Result and notes |
| --- | --- | --- | --- |
| `ROWSUM` | `ROWSUM()` | `=ROWSUM()` | sum of numeric cells in this row |
| `ROWAVG` | `ROWAVG()` | `=ROWAVG()` | average of numeric cells in this row |
| `ROWMEAN` | `ROWMEAN()` | `=ROWMEAN()` | same as ROWAVG() |

### Logic and conditions

Build simple decisions. Truthy means non-zero number or non-empty text.

| Function | Syntax | Example | Result and notes |
| --- | --- | --- | --- |
| `IF` | `IF(condition, then, else)` | `=IF(Hours > 2, "long", "short")` | then or else value |
| `IFEMPTY` | `IFEMPTY(value, fallback)` | `=IFEMPTY(Owner, "unassigned")` | fallback for empty cells |
| `IFERROR` | `IFERROR(value, fallback)` | `=IFERROR(SUM(Missing), 0)` | fallback when value errors |
| `AND` | `AND(a, b, ...)` | `=AND(Status == "done", Hours > 0)` | 1 when all are truthy, else 0 |
| `OR` | `OR(a, b, ...)` | `=OR(Status == "done", Status == "shipped")` | 1 when any value is truthy, else 0 |
| `NOT` | `NOT(value)` | `=NOT(Status == "done")` | 1 or 0 |
| `CONTAINS` | `CONTAINS(text, search)` | `=CONTAINS(Notes, "urgent")` | 1 when text contains search, else 0 |

### Text

Clean and combine text values.

| Function | Syntax | Example | Result and notes |
| --- | --- | --- | --- |
| `CONCAT` | `CONCAT(...parts)` | `=CONCAT(First, " ", Last)` | joined text |
| `UPPER` | `UPPER(text)` | `=UPPER(Name)` | uppercase text |
| `LOWER` | `LOWER(text)` | `=LOWER(Tag)` | lowercase text |
| `TRIM` | `TRIM(text)` | `=TRIM(Name)` | text without leading/trailing spaces |
| `LEFT` | `LEFT(text, n)` | `=LEFT(Code, 3)` | first n characters |
| `RIGHT` | `RIGHT(text, n)` | `=RIGHT(Code, 2)` | last n characters |
| `LEN` | `LEN(text)` | `=LEN(Notes)` | character count |
| `SUBSTRING` | `SUBSTRING(text, start, length)` | `=SUBSTRING(Code, 2, 4)` | text slice<br>start is 0-based. length is how many characters to take. |
| `REPLACE` | `REPLACE(text, search, replacement)` | `=REPLACE(Name, "old", "new")` | text with all matches replaced |

### Math

Use arithmetic directly, or call helpers when a cell needs formatting.

| Function | Syntax | Example | Result and notes |
| --- | --- | --- | --- |
| `Arithmetic` | `+  -  *  /` | `=Price * Qty` | number<br>Division by 0 shows a formula error. |
| `Comparisons` | `==  !=  <  <=  >  >=` | `=Hours >= 8` | 1 or 0 |
| `ROUND` | `ROUND(number, digits)` | `=ROUND(Price * Qty, 2)` | rounded number |
| `ABS` | `ABS(number)` | `=ABS(Balance)` | absolute value |
| `SQRT` | `SQRT(number)` | `=SQRT(Area)` | square root |
| `POW` | `POW(base, exponent)` | `=POW(2, 8)` | power |
| `MOD` | `MOD(a, b)` | `=MOD(Row, 2)` | remainder |

### Date and time

Return simple date strings or compare dates.

| Function | Syntax | Example | Result and notes |
| --- | --- | --- | --- |
| `TODAY` | `TODAY()` | `=TODAY()` | YYYY-MM-DD |
| `NOW` | `NOW()` | `=NOW()` | YYYY-MM-DD HH:MM:SS |
| `DATEDIFF` | `DATEDIFF(start, end, unit?)` | `=DATEDIFF(Start, Due, "d")` | difference as number<br>Units: ms, s, m, h, d. Full names work too. |
