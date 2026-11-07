### Reservation recovery must accept resolved addresses

- **What happened:** A route with three unresolved addresses needed more than the default credit limit, but Assistant recovery could only resubmit text.
- **Root cause:** The new conservative reservation assumed unknown coordinates while the consumer offered no way to retain a selected address point.
- **Error class:** Admission guidance names a recovery path the consumer cannot perform.
- **Guard:** Assistant uses the shared address autocomplete for stop repair, persists selected points through another refusal, clears them on edits, and permits recovery when credits remain. Service and desktop/phone browser tests cover consecutive refusals, selection, reload, and completion.
