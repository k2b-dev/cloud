### A colour audit over a whole emoji catalogue measures rendering, not colour

- **What happened:** In WebKit the primary scope test `input/emoji-picker: every demo and focus follows the scope` took 17 to 25 seconds of its 30-second budget on green runs and crossed it on #3335 and #2846 (#3373).
- **Root cause:** The test waited for the last option of the full emoji catalogue and then focused and read the computed colours of all about 1,970 nodes; every option is a roving focus target with the same styles. In Chromium the audit alone took 4.7 to 9.9 seconds, the whole case 7.5 to 14 seconds; rendering inside or outside the primary scope cost the same, so the picker itself was not slower.
- **Error class:** An exhaustive check over repeated identical elements that scales with data size instead of with the number of distinct styles.
- **Guard:** The test now audits the picker's chrome (search, skin tones, category toolbar, preview) and its first two sections with the active option, asserts that this slice holds all of them, and fails when it grows beyond 600 nodes; in Chromium the case takes 1.5 seconds.
