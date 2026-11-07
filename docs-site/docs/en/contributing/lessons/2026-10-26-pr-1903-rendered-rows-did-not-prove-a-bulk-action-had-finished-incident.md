### Rendered rows did not prove a bulk action had finished

- **What happened:** The Chat browser test saw all 50 visible unread badges disappear, then checked the unread state of 51 chats before the final batch finished.
- **Root cause:** The visible page was used as the completion signal for a paginated operation.
- **Error class:** A partial projection is mistaken for completed work.
- **Guard:** The desktop and phone browser tests wait for the terminal `read-all` result (`outcome: "done", more: false`) before asserting both visible badges and every chat's stored unread state.
