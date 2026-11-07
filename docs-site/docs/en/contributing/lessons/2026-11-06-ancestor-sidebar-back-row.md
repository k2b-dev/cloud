### Detail pages beside a sidebar repeated the way up as a back row

- **What happened:** A group, person, agent, or notification detail in Accounts showed "‹ Groups" and a small title above the page's own heading, although the sidebar beside it already highlighted Groups as the way up.
- **Root cause:** The workspace head hid its title and back link from 64 rem only when the visible sidebar held `aria-current="page"`; an item marked `active="ancestor"` (`aria-current="true"`) kept the back row by design.
- **Error class:** Chrome that repeats a way up or a title another visible surface already shows.
- **Guard:** `page-trail.browser.test.ts` checks that a deeper page whose sidebar marks its ancestor shows no back row from 1024 px and keeps it on tablet and phone; `advanced-layout.render.test.tsx` checks that the 64 rem rule covers ancestor items.
