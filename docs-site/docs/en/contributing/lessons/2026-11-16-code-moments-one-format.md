### One Code moment read three ways

- **What happened:** The same kind of moment read "15.11.26, 07:33" in a Gustav chat line, "on 15.11.26, 10:13" on the version card, and "So, 15.11., 15:28" on the Code page. The weekday itself read "So" on the Code page and "Mo." on the cards of My apps.
- **Root cause:** Each surface had its own formatter (`page-kit.tsx` `dayTime`, Assistant `formatCodeTime`, `formatCodeNextRun` and the My apps `dayOrTime`), and `Intl` writes a short weekday alone as "So" but inside a date pattern as "So., 15.11.". The Code page joined a weekday formatted alone to its date, while My apps formatted the whole date at once.
- **Error class:** A display format repeated per surface instead of owned once, and the same `Intl` option trusted to give the same word in every pattern.
- **Guard:** `formatCodeMoment` and `formatCodeDay` in `@k2b/cloud/code/schedule` with fixed weekday words, its unit test in `schedule.test.ts`, and `code-moment.behavior.test.tsx`, which renders one moment in the event line, the version card and the Code page and expects the same text.
