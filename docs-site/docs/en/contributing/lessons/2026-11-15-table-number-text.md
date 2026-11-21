### Numeric text formatting takes one pass through its digits

- **What happened:** Long decimal text could take disproportionately long to format in a table.
- **Root cause:** Repeated suffix matching retried work across the same digits.
- **Error class:** Unbounded work in text presentation.
- **Guard:** Number text tests preserve precision and bound long-input formatting in a subprocess.
