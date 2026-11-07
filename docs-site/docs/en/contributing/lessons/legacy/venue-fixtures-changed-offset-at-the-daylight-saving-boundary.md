### Venue fixtures changed offset at the daylight-saving boundary

- **What happened:** The shift-leaving behavior test expected 11:00–14:00 but rendered 10:00–13:00 as the real date approached Berlin's autumn clock change.
- **Root cause:** Its fixture added two days to the real clock, then used fixed UTC times while asserting summer local times.
- **Error class:** A relative calendar fixture with an unpinned clock changes its timezone offset.
- **Guard:** The Venue clarity suite pins and restores the system clock for every case. The shift-leaving assertion was reproduced with the clock set to 23 October 2026 and passes with the deterministic suite fixture.
