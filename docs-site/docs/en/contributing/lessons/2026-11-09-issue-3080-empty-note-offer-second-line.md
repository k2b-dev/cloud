### The empty-note template offer stayed after Enter and sat in front of the caret

- **What happened:** On an empty note, Enter behind the title left the "Start with a template" offer in place, with the caret on the new line right in front of it; it left only once the person typed.
- **Root cause:** The offer used `isBlankPage`, which drops empty lines, so `# Title\n\n` still counted as blank, and it was anchored below line 1, over the empty line where the caret goes.
- **Error class:** Treating a whitespace-only document as untouched; an overlay anchored over a line the caret can reach.
- **Guard:** `page-templates.behavior.test.ts` pins which texts count as blank; `page-templates.browser.test.ts` checks on desktop and phone that the offer starts below the caret line, leaves with an empty second line, and returns on undo and on a collaborator's edit.
