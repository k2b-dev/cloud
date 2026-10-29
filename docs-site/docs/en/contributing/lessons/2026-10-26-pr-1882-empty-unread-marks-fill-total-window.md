### Empty unread marks can fill the unread-message window

- **What happened:** A capped unread-message total could omit an older unread message after enough newer chats contained only a manual unread mark.
- **Root cause:** The candidate query inherited read-all's selection of unread marks. Those zero-message candidates consumed the message-count cap before the total was calculated.
- **Error class:** Non-contributing rows consume a bounded aggregate window
- **Guard:** Select candidates with positive unread-message counts before applying the cap. The read-state integration suite places more than that cap of empty marks before one unread message; read-all keeps its separate mark-clearing semantics.
