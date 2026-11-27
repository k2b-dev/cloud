### Options that keep only their icon gave no hint of their name

- **What happened:** At a narrow Main, such as a 1024 px window beside the navigation, the notebook graph's display
  options showed only their icons (#4221). Their names stayed for assistive technology, but a pointer over an icon
  showed nothing, so a sighted person had to guess which display an icon meant. A test also checked that the chosen
  name stayed inside its option on the phone, where the name is a 1 px box for assistive technology, so it could not
  fail there.
- **Root cause:** `SegmentOption` had no way to carry a hint, and the switcher hid its labels without adding one. The
  test measured a box that the phone layout makes 1 px wide.
- **Error class:** A control that drops its visible words in a narrow place without a hint in their place, and a test
  that measures something the state under test hides.
- **Guard:** `SegmentOption.title` puts a hint on the option. `notebook-graph.browser.test.ts` checks the hints at a
  Main of 664 and 600 px, and checks the chosen name inside its option only where names are in sight (768 px and
  wider). `actions.render.test.tsx` checks that `title` reaches the option and only that option.
