### Recipient text uses its structured name and address

- **What happened:** Draft recipient text could take disproportionately long to format.
- **Root cause:** Formatting searched the combined text instead of using the supplied name and address fields.
- **Error class:** Unbounded work in text presentation.
- **Guard:** Block text tests cover recipient combinations and bound long-input formatting in a subprocess.
