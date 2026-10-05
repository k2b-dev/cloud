# Notebook table formulas

This is the complete formula language available in Markdown table cells. Functions not listed here do not exist. For the other Markdown constructs, read [Notebook Markdown](markdown.md); for CLI workflows, start with [Notebooks CLI](index.md).

## Contents

- [Operators](#operators)
- [Progress](#progress)
- [Column aggregates](#column-aggregates)
- [Current-row aggregates](#current-row-aggregates)
- [Logic and errors](#logic-and-errors)
- [Text](#text)
- [Math](#math)
- [Dates](#dates)
- [Formula examples](#formula-examples)

A table cell is a formula when its content starts with `=`. Function names and column names are case-insensitive. Reference a column by its header: a bare name contains only ASCII letters, digits, and `_` and does not start with a digit; wrap every other name in backticks, such as `` =SUM(`Größe (m²)`) `` or `` =`Unit price` * Quantity ``. Text values use double quotes. Comparisons return `1` for true and `0` for false.

Write numbers with a decimal point and without thousands separators or currency signs: `1,5` reads as `1`, and `12.000` as `12`.

Formulas compute when the note is displayed. `cat`, `search`, and queries see the formula source, not its result. A formula can use other formula cells; a cycle shows an error in the cell.

```markdown
| Item | Price | Quantity | Total |
|---|---:|---:|---:|
| Hosting | 20 | 3 | =Price * Quantity |
| Total | | | =SUM(Total) |
```

## Operators

Arithmetic: `+`, `-`, `*`, `/`.

Comparison: `==`, `!=`, `<`, `<=`, `>`, `>=`. ISO dates such as `2026-10-12` and timestamps such as `2026-10-12 09:30` compare in time order, so `=Due < TODAY()` works; ordering a date against a value that is not a date is a formula error.

## Progress

| Function | Meaning |
|---|---|
| `PROGRESS(ratio)` | Progress from a ratio such as `0.75`. |
| `PROGRESS(done, total)` | Progress from completed and total values. |
| `PERCENT(part, total)` | Percentage number; returns `40` for 40%, not `0.4`. |

## Column aggregates

| Function | Meaning |
|---|---|
| `SUM(column)` | Sum numeric cells. |
| `AVG(column)`, `MEAN(column)` | Arithmetic mean. |
| `MIN(column)`, `MAX(column)` | Smallest or largest numeric value. |
| `COUNT(column)` | Count non-empty values. |
| `MEDIAN(column)` | Median numeric value. |
| `UNIQUE(column)` | Count distinct non-empty values. |
| `STDEV(column)` | Standard deviation of numeric values. |
| `COUNTIF(column, value)` | Count cells equal to the value. |
| `SUMIF(sumColumn, conditionColumn, value)` | Sum values whose corresponding condition cell equals the value. |

`COUNTIF` and `SUMIF` match a cell the way `==` does: text exactly, numbers and ISO dates by value. A `5 €` cell matches both `5` and `"5 €"`, but not `"5.00 €"`.

A column aggregate reads every row of the column except its own cell, including other summary rows. Empty, non-numeric, and failing cells are skipped; `COUNT` counts non-empty cells. Keep one summary row at the end of a table. A row in which at least half of the formulas are aggregates is shown as a total row.

## Current-row aggregates

| Function | Meaning |
|---|---|
| `ROWSUM()` | Sum numeric cells in the current row. |
| `ROWAVG()`, `ROWMEAN()` | Mean of numeric cells in the current row. |

## Logic and errors

| Function | Meaning |
|---|---|
| `IF(condition, whenTrue, whenFalse)` | Conditional value. |
| `IFEMPTY(value, fallback)` | Fallback for an empty value. |
| `IFERROR(value, fallback)` | Fallback when evaluation fails. |
| `AND(value, ...)` | True when every value is truthy. |
| `OR(value, ...)` | True when any value is truthy. |
| `NOT(value)` | Negate truthiness. |
| `CONTAINS(text, search)` | Test whether text contains a value. |

Truthy means a non-zero number or non-empty text. A cell such as `0 €` or `0%` is text and therefore truthy; compare the amount instead, for example `Price > 0`.

## Text

| Function | Meaning |
|---|---|
| `CONCAT(value, ...)` | Join values. |
| `UPPER(text)`, `LOWER(text)` | Change case. |
| `TRIM(text)` | Remove surrounding whitespace. |
| `LEFT(text, count)`, `RIGHT(text, count)` | Take characters from one side. |
| `LEN(text)` | Character count. |
| `SUBSTRING(text, start, length)` | Extract a substring; `start` is zero-based. |
| `REPLACE(text, search, replacement)` | Replace text. |

## Math

| Function | Meaning |
|---|---|
| `ROUND(number, digits)` | Round to decimal digits. |
| `ABS(number)` | Absolute value. |
| `SQRT(number)` | Square root. |
| `POW(base, exponent)` | Exponentiation. |
| `MOD(number, divisor)` | Remainder. |

## Dates

| Function | Meaning |
|---|---|
| `TODAY()` | Current date. |
| `NOW()` | Current date and time. |
| `DATEDIFF(start, end, unit?)` | Difference between dates. |

Write dates as ISO dates, such as `2026-10-12`. `TODAY()` returns the current date as `YYYY-MM-DD` and `NOW()` as `YYYY-MM-DD HH:MM:SS`, both at the time the note is displayed. `DATEDIFF` returns `end` minus `start`, negative when `end` is earlier, in days unless a unit is given. Units are `ms`, `s`, `m`, `h`, and `d`, or `milliseconds`, `seconds`, `minutes`, `hours`, and `days`. Results can be fractional; wrap them in `ROUND(…, 0)` for whole numbers. Dates and timestamps without an offset are local time, like `TODAY()` and `NOW()`, in `DATEDIFF` and in comparisons alike. Two dates are always a whole number of days apart, also across a daylight saving change.

## Formula examples

```text
=Price * Quantity
=IF(Status == "paid", Amount, 0)
=SUMIF(Amount, Status, "paid")
=IFERROR(DATEDIFF(Start, End, "d"), 0)
=ROUND(DATEDIFF(TODAY(), Deadline), 0)
=PROGRESS(Completed, Total)
=CONCAT(UPPER(Category), ": ", TRIM(Name))
```

Use formulas for values derived from one table; a formula cannot read other tables or notes. To summarize several notes, put the facts in [data blocks](markdown.md#data-blocks) and list them with a `:::query`.
