### Plain-text note titles could still contain a tag

- **What happened:** CodeQL flagged `plainText()` in `pwas/notes/src/lib/derive.ts` on #2125 as an incomplete multi-character sanitization. A title such as `<scr<script>ipt>` became `<script>` after the tag removal. Every place that shows the value escapes it, so nothing ran, but the "plain text" was not plain.
- **Root cause:** One pass of `/<[^<>]*>/g` removes the inner tag and joins the outer halves into a new one. Repeating the pass until nothing changes would close that gap, but it costs quadratic time on deeply nested input, which the previous fix to this function had just removed.
- **Error class:** A single regex pass removes a pattern whose removal can create the same pattern again.
- **Guard:** After the tag pass, `plainText()` drops every remaining `<`, still in linear time. `pwas/notes/src/lib/derive.test.ts` ("plain text keeps no tag, also where removing one joins two halves") fails without that step. CodeQL runs on every pull request.
