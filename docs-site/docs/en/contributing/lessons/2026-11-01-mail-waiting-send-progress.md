### Immediate sends waiting in line were absent from the send overview

- **What happened:** A large immediate send queue appeared empty in the sidebar and scheduled-send list.
- **Root cause:** List, detail and count queries required a non-null scheduledAt in the command payload instead of using durable waiting state.
- **Error class:** A read model filters on an optional request field instead of the state it represents.
- **Guard:** Assigned-access integration tests cover immediate sends, later sends with future due times, undo windows, list/count agreement, pagination with full database timestamp precision and the cancellation fence; CLI tests cover totals and structured output.
