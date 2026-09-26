# Notebook table formulas

This is the complete formula language available in Markdown table cells. For the Notebooks content model and CLI workflows, start with [Notebooks CLI](index.md).

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

A table cell is a formula when its content starts with `=`. Function names are case-insensitive. Reference a column by name; wrap names containing spaces or special characters in backticks. Comparisons return `1` for true and `0` for false. Aggregate formulas exclude their own cell to avoid self-reference.

```markdown
| Item | Price | Quantity | Total |
|---|---:|---:|---:|
| Hosting | 20 | 3 | =Price * Quantity |
| Total | | | =SUM(Total) |
```

## Operators

Arithmetic: `+`, `-`, `*`, `/`.

Comparison: `==`, `!=`, `<`, `<=`, `>`, `>=`.

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
| `COUNTIF(column, value)` | Count exact string matches. |
| `SUMIF(sumColumn, conditionColumn, value)` | Sum values whose corresponding condition cell exactly matches. |

`COUNTIF` and `SUMIF` use exact string matching.

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

`DATEDIFF` units are `ms`, `s`, `m`, `h`, and `d`, with their corresponding full unit names accepted by the evaluator.

## Formula examples

```text
=Price * Quantity
=IF(Status == "paid", Amount, 0)
=SUMIF(Amount, Status, "paid")
=IFERROR(DATEDIFF(Start, End, "d"), 0)
=PROGRESS(Completed, Total)
=CONCAT(UPPER(Category), ": ", TRIM(Name))
```

Use formulas for values derived from one table. Use a script block when the task needs cross-note data, prompts, networked notebook operations, or custom rendered UI.
