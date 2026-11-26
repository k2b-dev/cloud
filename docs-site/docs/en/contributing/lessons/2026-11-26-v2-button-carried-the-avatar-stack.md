### Every island grew by 3 KB through the person on a button

- **What happened:** After the identity and head-media primitives (#4208, #4223), the small Cloud island `PwaPartCount` grew from 92,479 B to 95,501 B (98,070 B to 101,100 B on the branch W7 measured), close to its budget of 98,304 B. The island uses none of the new parts.
- **Root cause:**
  - Every island carries the error fallback `IslandError`. It shows `Failed`, whose retry is a `Button`, and a `Button` imports `Avatar` for its `avatar` prop.
  - `Avatar.Stack = …` was a top-level assignment, so the bundler kept the whole stack wherever `Avatar` stood.
  - The face set its colour through `custom()`. That runs `colorStyle`, which derives six inks for a mark; a face reads only `--k2-c`.
  - Together these were 3 KB in every island.
- **Error class:** A part attached to a component by a top-level assignment, or a shared helper that does more than its caller needs, rides into every bundle that uses the component, also through a deep import such as the retry of an error fallback.
- **Guard:**
  - The `island-bundles` rule caught it.
  - `Avatar` is now a pure `Object.assign` with its `Stack`, so the stack is dropped where it is not used.
  - `Button` imports the plain face.
  - The face validates its colour with `safeColor` alone.
  - `PwaPartCount` is 93,191 B now; the 712 B above main are the colour validation and the grapheme-safe initials it needs.
