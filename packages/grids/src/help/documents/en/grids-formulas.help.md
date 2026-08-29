---
id: grids-formulas
title: Formulas
icon: ti ti-function
description: Calculate values from fields with one shared expression language.
order: 126
---
Formulas calculate a value from fields in one record. Use them for totals, labels, date differences, conditions, and other results that should follow the saved inputs automatically.

Create a **Formula field** when the result belongs on every record. Add a **Computed column** when the calculation is only needed in one query. In GQL, the same expression language can filter records or create an output column.

## Where formulas run {icon="math-function"}

- **Formula fields** recalculate when records are read and can appear in views, cards, detail panels, Grids Apps, and documents.
- **Computed columns** are temporary query output and do not add a field to the table.
- **GQL conditions** use an expression inside `where` or `having`.
- **GQL output** uses `formula(expression) as alias`.

Formulas use the complete query result, not only the records currently visible on screen. The same expression behaves consistently in tables, views, computed columns, and GQL.

## Expression rules {icon="book-2"}

:::reference
- **Fields:** Reference a simple field as `Price`. Quote names containing spaces or punctuation as `"Unit price"`. Use `{field-id}` when generated configuration must survive a rename.
- **Literals:** Write text in single quotes, numbers without quotes, and the values `true`, `false`, and `null` directly. Double quotes always mean a field name. In text, use `\\'`, `\\\\`, `\\n`, `\\r`, or `\\t` for a quote, backslash, or control character.
- **Grouping:** Use parentheses to make a calculation or condition explicit. An optional leading `=` is accepted, but formulas are normally written without it.
- **Functions:** Function names are case-insensitive. Arguments are comma-separated and must match the function's documented count.
:::

Build a formula from a representative record and check empty, zero, and boundary values. If a field changes type or is removed, update dependent formulas before relying on their output.

### Operators and precedence

| Priority | Operators | Meaning |
| --- | --- | --- |
| 1 | `-value`, `not value`, `!value` | Numeric negation or logical negation |
| 2 | `*`, `/`, `%` | Multiply, divide, remainder |
| 3 | `+`, `-` | Add, subtract; two non-numeric text values can be joined with `+` |
| 4 | `<`, `<=`, `>`, `>=` | Compare numbers, dates, or compatible text |
| 5 | `=`, `!=` | Equal or not equal |
| 6 | `and`, `&&` | Both conditions are true |
| 7 | `or`, `||` | At least one condition is true |

Higher rows bind more tightly. Parentheses override this order. Prefer the word forms `and`, `or`, and `not` in formulas that people maintain directly.

### Empty values, truth, and errors

- Arithmetic and ordered comparisons return empty when either side is empty. Two empty values are equal.
- `null`, `false`, `0`, and empty text are false in a condition; other non-empty values are true.
- `and`, `or`, `AND`, and `OR` stop as soon as the result is known. `IF` evaluates only the selected branch.
- Invalid calculations such as division or remainder by zero, a negative square root, or the wrong number of function arguments produce a visible formula error rather than a misleading value.
- `IFEMPTY(value, fallback)` handles `null` and empty text. `IFERROR(value, fallback)` handles formula errors. Their fallback is evaluated only when needed.
- `CONCAT(value, ...)` is the clearest way to combine text. Numeric-looking text participates in numeric arithmetic, so do not rely on `+` for labels.

The functions named Aggregate below combine arguments from the current record, for example `SUM(Subtotal, Tax)`. They do not summarize several records. Use GQL `aggregate` when a report needs totals across rows.

## Common formulas {icon="math-function"}

**Line total**

```text
price * quantity
```

**Gross amount**

```text
"Unit price" * quantity * 1.19
```

**Fallback text**

```text
IFEMPTY(notes, 'No notes')
```

**Conditional label**

```text
IF(inStock, 'Available', 'Out of stock')
```

**Days until due**

```text
DATEDIFF(TODAY(), dueDate, 'days')
```

**Safe division**

```text
IFERROR(total / quantity, 0)
```

## Full function reference {icon="book-2"}

| Group     | Function                           | What it does                                                             | Returns |
| --------- | ---------------------------------- | ------------------------------------------------------------------------ | ------- |
| Aggregate | SUM(value, ...)                    | Add numeric values.                                                      | number  |
| Aggregate | AVG(value, ...)                    | Average numeric values.                                                  | number  |
| Aggregate | MEAN(value, ...)                   | Alias for AVG.                                                           | number  |
| Aggregate | COUNT(value, ...)                  | Count non-empty values.                                                  | number  |
| Aggregate | MIN(value, ...)                    | Smallest numeric value.                                                  | number  |
| Aggregate | MAX(value, ...)                    | Largest numeric value.                                                   | number  |
| Aggregate | MEDIAN(value, ...)                 | Middle numeric value.                                                    | number  |
| Number    | ABS(number)                        | Absolute value.                                                          | number  |
| Number    | ROUND(number, digits?)             | Round a number.                                                          | number  |
| Number    | FLOOR(number)                      | Round down.                                                              | number  |
| Number    | CEIL(number)                       | Round up.                                                                | number  |
| Number    | SQRT(number)                       | Square root.                                                             | number  |
| Number    | POW(base, exponent)                | Power.                                                                   | number  |
| Number    | MOD(a, b)                          | Remainder.                                                               | number  |
| Number    | PERCENT(part, total)               | Part as percent of total.                                                | number  |
| Logic     | IF(condition, then, else)          | Choose by condition.                                                     | any     |
| Logic     | IFEMPTY(value, fallback)           | Fallback for empty values.                                               | any     |
| Logic     | IFERROR(value, fallback)           | Fallback for formula errors.                                             | any     |
| Logic     | AND(value, ...)                    | All values are truthy. In GQL where/having, prefer the \`and\` operator. | boolean |
| Logic     | OR(value, ...)                     | Any values are truthy. In GQL where/having, prefer the \`or\` operator.  | boolean |
| Logic     | NOT(value)                         | Invert truthiness. In GQL where/having, prefer the \`not\` operator.     | boolean |
| Logic     | ISBLANK(value)                     | True when empty.                                                         | boolean |
| Text      | CONTAINS(text, search)             | Substring match.                                                         | boolean |
| Text      | STARTSWITH(text, prefix)           | True when text starts with prefix.                                       | boolean |
| Text      | ENDSWITH(text, suffix)             | True when text ends with suffix.                                         | boolean |
| Text      | ICONTAINS(text, search)            | Case-insensitive substring match.                                        | boolean |
| Text      | ISTARTSWITH(text, prefix)          | Case-insensitive starts-with match.                                      | boolean |
| Text      | IENDSWITH(text, suffix)            | Case-insensitive ends-with match.                                        | boolean |
| Text      | CONCAT(value, ...)                 | Join values as text.                                                     | text    |
| Text      | LEN(text)                          | Text length.                                                             | number  |
| Text      | LOWER(text)                        | Lowercase text.                                                          | text    |
| Text      | UPPER(text)                        | Uppercase text.                                                          | text    |
| Text      | TRIM(text)                         | Trim whitespace.                                                         | text    |
| Text      | LEFT(text, n)                      | First n characters.                                                      | text    |
| Text      | RIGHT(text, n)                     | Last n characters.                                                       | text    |
| Text      | SUBSTRING(text, start, length)     | Text slice with 0-based start.                                           | text    |
| Text      | REPLACE(text, search, replacement) | Replace all matches.                                                     | text    |
| Date      | TODAY()                            | Current date.                                                            | date    |
| Date      | NOW()                              | Current date and time.                                                   | date    |
| Date      | YEAR(date)                         | Year number.                                                             | number  |
| Date      | MONTH(date)                        | Month number.                                                            | number  |
| Date      | DAY(date)                          | Day number.                                                              | number  |
| Date      | DATEADD(date, count, unit?)        | Add time to a date; the unit defaults to days.                           | date    |
| Date      | DATEDIFF(from, to, unit?)          | Difference between dates; the unit defaults to days.                     | number  |

`ROUND` defaults to zero decimal places and accepts negative places for tens, hundreds, and larger positions. `LEFT`, `RIGHT`, and `SUBSTRING` treat negative lengths as zero; `SUBSTRING` starts at position 0. `REPLACE` replaces every match.

`TODAY()` returns the current date and `NOW()` returns the current date and time. Date-time calendar operations use the request's display timezone; when none is supplied, Grids uses the Cloud application timezone. Date-only values remain calendar dates. `DATEADD` accepts day(s), hour(s), minute(s), month(s), and year(s); it defaults to days and keeps month-end dates valid when adding months or years. `DATEDIFF` accepts day(s), hour(s), minute(s), and second(s), defaults to days, and returns `to - from`, rounded down to whole units.

:::note Formula fields do not store a second value
They are calculated from the current record when read. Change the source fields when the result is wrong rather than editing the displayed formula result.
:::
