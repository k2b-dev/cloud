### Provider error summaries kept script bodies with loose end tags

- **What happened:** CodeQL flagged `stripHtml()` in `packages/notebooks/src/service/backup.ts` on #2218 as a bad HTML filtering regexp. A provider error page with `</script >` kept its script body in the snapshot error text. The text only reaches logs and error messages as plain text, so nothing ran, but the summary was not plain.
- **Root cause:** The script and style patterns matched only the exact end tag `</script>`, and one tag pass could still join two halves into a new tag.
- **Error class:** A single regex pass removes a pattern whose removal can create the same pattern again.
- **Guard:** `stripHtml()` accepts end tags with spaces or attributes, drops an unclosed script body, and removes every `<` left after the tag pass. `packages/notebooks/src/service/backup.test.ts` ("provider text never keeps markup, script bodies or tags joined by removal") covers the variants. CodeQL runs on every pull request.
