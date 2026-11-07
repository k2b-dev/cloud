### Bulk chat fixtures must maintain thread activity

- **What happened:** A short system-thread refresh test expected an unread thread outside its 100-candidate activity window.
- **Root cause:** The fixture inserted a message directly without advancing thread activity as the message service does.
- **Error class:** Bulk fixtures omit a domain write's related projection update.
- **Guard:** The system-chat integration test checks that an old unread thread stays outside the bounded refresh, then advances its fixed activity timestamp and checks inclusion.
