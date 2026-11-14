### An unavailable heartbeat froze a safely journaled draft

- **What happened:** Mail stopped offline typing after a failed heartbeat, and idle or same-person sessions unnecessarily blocked writing.
- **Root cause:** The browser treated unavailable lease confirmation as proof of lost ownership, acquired leases while reading, and renewed them without input. The server tied same-person acquisition to one editor instance.
- **Error class:** Confusing transport availability with ownership and durable storage.
- **Guard:** Mail draft session behavior tests cover offline writing and reconnect with and without takeover, acquisition after input, stopped renewals after inactivity or hiding, and return from BFCache. The draft integration suite checks person-owned acquisition, a full renewal lifetime, closing one own editor while another writes, rejected stale tokens, and recovery preserving both writers' text. A reading tab never imports an active editor's handoff journal.
