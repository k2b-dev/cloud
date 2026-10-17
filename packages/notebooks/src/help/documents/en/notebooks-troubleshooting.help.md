---
id: notebooks-troubleshooting
title: "Troubleshooting"
icon: "ti ti-lifebuoy"
description: "Fix problems with queries, data, formulas, attachments, and views."
order: 180
---

Before you change the structure of a note, check its Markdown source and your access to the notebook.

## Fix common problems {icon="stethoscope"}

:::reference
- **A query shows an error:** Open its source and check the marked line. Use source: notes and supported fields and operators. Close the block with :::.
- **Named data is missing from a query:** Put @name directly above :::data. Use unique names and keys and flat values. Spell the field the same way in the query. Notebooks does not index invalid or duplicate named data.
- **A query returns no notes:** Check scope, tags, value types, and match. The default match: all requires every filter. The query reads saved notes, not unsaved text in another editor.
- **A formula shows an error:** Check the function spelling, the number of arguments, the column names, and circular references. Column names with spaces need backticks.
- **An attachment is missing:** Check that the file exists in this notebook and that the Markdown uses attach://shortId.
- **Editing or comments are missing:** **View** access opens only Book. With **Edit** or **Manage** access, switch to **Write** or **Read-only** for the detail panel. You cannot edit locked notes.
- **An old script no longer runs:** Executable scripting is no longer supported. Existing script fences stay readable code. Replace page lists with :::query and contents with :::toc. Script buttons and write actions have no replacement.
:::

## An image is missing from the PDF {icon="photo"}

The PDF marks each missing image with **Image not included: …** and a reason. The download dialog lists the same omissions.

:::reference
- **File not found:** Attach the file to this notebook again. An attachment from another notebook is not available here.
- **Format cannot be printed:** Use JPEG, PNG, WebP or GIF. SVG files stay available as downloads.
- **File could not be read:** Open the file to check it, then export it again and attach the new copy.
- **File too large:** Attach a smaller image. The notebook's attachment limit also applies to PDF images.
- **No room left in the PDF:** Use smaller images or split the note. Images share **Max input bytes** with the document; an administrator can raise that budget. Large images print at 300, 200 or 150 dpi.
- **Preparation took too long:** Try again, or use smaller images.
- **Address not allowed:** Attach the image to this notebook and use its attachment link.
- **Not printed in PDFs yet:** External HTTP(S) images are not included yet. Attach the image instead, or open the note to view it.
- **Address not reachable:** Check the address or try again later.
:::

## Check updates {icon="refresh"}

**Write** synchronizes the note text with other editors. Saved changes refresh query previews and Book content. **Read-only** does not receive shared text edits. Reload it after the saved source changes.

If **Write** stops syncing, for example because your session ended or the note was deleted, the note stays on screen and becomes read-only. The bar under the note says whether your changes are saved. Use **Sign in again** to continue editing after you sign in. Otherwise, use **Copy text** before you **Reload**. If changes are not saved, Notebooks asks before you leave the note.

If a Book page cannot refresh, its last readable content stays visible, and you can try again. If your access ends or the page disappears, Notebooks stops showing the old content and checks the page again. Without JavaScript, reload the page to see changes.
