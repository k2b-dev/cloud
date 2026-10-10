---
id: notebooks-table-formulas
title: "Table formulas"
icon: "ti ti-math-function"
description: "Look up the complete syntax and every function of table formulas."
order: 140
---

Table formulas turn cells of a Markdown table into computed values. They are small on purpose. Write the formula in the cell and keep the source columns visible.

**Formula shape**

## Start from small examples {icon="flask"}

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

## Follow the formula rules {icon="ruler-2"}

:::reference
- **Start with =:** A formula cell starts with =, for example =SUM(Hours).
- **Refer to columns by name:** Use the column name directly. Put names with spaces in backticks, for example =SUM(`Total Cost`).
- **Comparisons return numbers:** >, <, ==, and the other comparison operators return 1 or 0.
- **Formula cells do not count themselves:** A column total skips its own formula cell. =SUM(Hours) does not include the total cell.
:::

**Reference**

## Look up a function {icon="book-2"}

### Autocomplete and rendering use the same functions

Table autocomplete, the edit preview, and the read mode use the same function names.

### Names are case-insensitive

Uppercase names are easier to read. Lowercase function names also work.

### Progress and percentages

Use these functions when a cell shows completion or a percentage.

| Function | Syntax | Example | Result and notes |
| --- | --- | --- | --- |
| `PROGRESS` | `PROGRESS(ratio)` | `=PROGRESS(0.4)` | 40% progress bar<br>The bar shows at least 0% and at most 100%. |
| `PROGRESS` | `PROGRESS(done, total)` | `=PROGRESS(2, 10)` | 2/10 progress bar<br>total must not be 0. |
| `PERCENT` | `PERCENT(part, total)` | `=PERCENT(Done, Total)` | percent number<br>Returns 40 for 40%, not 0.4. |

### Column aggregates

These functions read a whole column. Numeric functions ignore empty cells and cells without a number.

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
| `COUNTIF` | `COUNTIF(column, value)` | `=COUNTIF(Status, "done")` | matching cell count<br>A cell matches as with `==`: text exactly, numbers and dates by value. |
| `SUMIF` | `SUMIF(sumColumn, conditionColumn, value)` | `=SUMIF(Hours, Status, "done")` | conditional sum<br>Matches cells like COUNTIF. |

### Row aggregates

These functions read the current row. They skip the cell that contains the formula.

| Function | Syntax | Example | Result and notes |
| --- | --- | --- | --- |
| `ROWSUM` | `ROWSUM()` | `=ROWSUM()` | sum of numeric cells in this row |
| `ROWAVG` | `ROWAVG()` | `=ROWAVG()` | average of numeric cells in this row |
| `ROWMEAN` | `ROWMEAN()` | `=ROWMEAN()` | same as ROWAVG() |

### Logic and conditions

Build simple decisions. A value is true when it is a number other than zero or text that is not empty. A cell such as `0 €` is text, so compare the amount instead, for example `Price > 0`.

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

Clean up and combine text values.

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

Use arithmetic directly. Use the helper functions when a cell needs formatting.

| Function | Syntax | Example | Result and notes |
| --- | --- | --- | --- |
| `Arithmetic` | `+  -  *  /` | `=Price * Qty` | number<br>Division by 0 shows a formula error. |
| `Comparisons` | `==  !=  <  <=  >  >=` | `=Hours >= 8` | 1 or 0<br>Dates such as 2026-10-12 and timestamps compare in time order, for example `=Due < TODAY()`. A date is only ordered against another date. |
| `ROUND` | `ROUND(number, digits)` | `=ROUND(Price * Qty, 2)` | rounded number |
| `ABS` | `ABS(number)` | `=ABS(Balance)` | absolute value |
| `SQRT` | `SQRT(number)` | `=SQRT(Area)` | square root |
| `POW` | `POW(base, exponent)` | `=POW(2, 8)` | power |
| `MOD` | `MOD(a, b)` | `=MOD(Row, 2)` | remainder |

### Date and time

These functions return simple date strings or compare dates.

| Function | Syntax | Example | Result and notes |
| --- | --- | --- | --- |
| `TODAY` | `TODAY()` | `=TODAY()` | YYYY-MM-DD |
| `NOW` | `NOW()` | `=NOW()` | YYYY-MM-DD HH:MM:SS |
| `DATEDIFF` | `DATEDIFF(start, end, unit?)` | `=DATEDIFF(Start, Due, "d")` | difference as number<br>Units: ms, s, m, h, d. Full names work too. Dates and times without a time zone are local time. |
