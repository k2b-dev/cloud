### An empty approval list sounded like abandonment

- **What happened:** Cloud Login and the shared approvals page said "Nothing is waiting for you" when every confirmation was done.
- **Root cause:** The empty state described absence instead of a completed task.
- **Error class:** An empty approval list sounds like abandonment.
- **Guard:** Convention: use "You're all set." / "Alles erledigt." for this empty state; the Login and shared approvals behavior tests assert the approved wording.
