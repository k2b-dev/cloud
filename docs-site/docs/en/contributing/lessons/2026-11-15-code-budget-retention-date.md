### Bind retention timestamps before converting them to dates

- **What happened:** The Code data integration failed while expiring daily AI budget rows (#3422); a later keyset test then failed because the interrupted sweep left an old run in its shared fixture.
- **Root cause:** A JavaScript `Date` bound directly to a PostgreSQL `date` cast reached the database as a locale-formatted date string that PostgreSQL rejected.
- **Error class:** Driver parameter serialization differs between timestamp and date inputs.
- **Guard:** `expireCodeRuns` sends an ISO timestamp and converts it through `timestamptz` to `date`, preserving the database's existing day boundary. The data integration seeds expired, boundary-day and newer budget rows and verifies pruning alongside the exact run-retention boundary; no fixture constraint or assertion was relaxed.
