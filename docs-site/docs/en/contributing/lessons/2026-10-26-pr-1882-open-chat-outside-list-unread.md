### An open chat can be outside the loaded list

- **What happened:** Back in the Cloud app counted an open archived chat among the other unread chats.
- **Root cause:** The subtraction used only loaded list rows. An authorized open chat can be archived, filtered out or beyond the loaded page.
- **Error class:** A paged list is mistaken for the complete active state
- **Guard:** Subtract the open private member chat even when it is absent from the list. A ChatWorkspace behavior test opens an archived chat outside the list and receives successive personal read events, checking that the other-chat count stays correct after each aggregate refresh. The existing store notifications already refresh the aggregate; no additional trigger is needed.
