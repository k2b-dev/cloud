### Load table controls when Chat presents a table

- **What happened:** Adding table controls left almost no room in the Assistant PWA island's original 2160 KiB budget.
- **Root cause:** Chat imported the table renderer, search and grouping controls into every initial island, including chats without tables.
- **Error class:** Optional presentation code entered the initial island closure through an eager import.
- **Guard:** The `island-bundles` check restores the 2160 KiB limit. Chat loads the table module on first use; browser tests hold code and rows separately and compare the exact frame at desktop and phone widths. Failed imports offer a reload.
