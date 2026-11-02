### Opening the phone menu rebuilt the whole navigation for every row

- **What happened:** With 350 folders, the phone menu of a mailbox took about 8 s to open on an unthrottled phone viewport. With a 4x slower CPU it did not open within 30 s.
- **Root cause:** `createNavigation` handed out the application's item function as it was. Each read rebuilt the whole tree, and rendering reads it many times: 66 builds for a tree of three items in the guard's fixture.
- **Error class:** An accessor that looks like a cheap read but does the work on every call, so its cost grows with the square of the list.
- **Guard:** `navigation.behavior.test.tsx` requires one build per change and none before the first read.
