### Task deadline dates became times

- **What happened:** Choosing a task deadline date silently assigned 17:00. While all-day deadlines were built, the iCal export wrote the day before when the server process ran west of UTC, and the `@k2b/ui` date pickers labelled a date key one day late in a zone far east of the runtime's, such as Pacific/Kiritimati.
- **Root cause:** Task storage and inputs represented every deadline as a timestamp; ical-generator writes a `VALUE=DATE` from the process's local date getters, so a UTC-midnight `Date` moved back a day; the pickers formatted a date key as a zone-less local noon in the picker's zone.
- **Error class:** Date-only value passes through a time zone, the class of the Contacts birthday fix in [#1364](https://github.com/k2b-dev/cloud/pull/1364).
- **Guard:** Spaces stores calendar dates in `DATE`, reads them as text, and tests input validation, formatting, overdue boundaries west and east of UTC, API switching, query grouping, and iCal dates with the process in several zones.
