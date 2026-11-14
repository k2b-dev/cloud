### Pin the clock when frozen markup holds a relative date

- **What happened:** At midnight UTC on 9 November every unit run turned red, including the merge queue for every pull request. The byte-equal guard for fields without a suggestion compared the date field's server markup with a recording from 8 November, and the field's status line had moved from "Wednesday, 11 days ago" to "Wednesday, 12 days ago".
- **Root cause:** The date field names its day relative to today. The guard froze that output but not the clock, so the recording went stale one day after it was made.
- **Error class:** A snapshot of output that reads the current date, recorded without a fixed clock.
- **Guard:** The guard pins the clock with `setSystemTime` to the recording day and restores it afterwards. The `test-clock` rule only finds clock reads in test code, not dates a rendered component reads for itself, so a frozen expectation that contains relative dates must pin the clock in the same test.
