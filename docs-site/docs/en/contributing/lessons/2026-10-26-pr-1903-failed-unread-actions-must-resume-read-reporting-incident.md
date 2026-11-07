### Failed unread actions must resume read reporting

- **What happened:** A failed “Mark unread from here” restored the visible state but left messages seen during the request unreported.
- **Root cause:** The merged error path restored the reporter's pause flag without activating it again.
- **Error class:** Async rollback restores state but omits the work needed to resume its lifecycle.
- **Guard:** The desktop and phone Chromium cases hold an unread write, receive another message, reject the write, and require reading to resume.
