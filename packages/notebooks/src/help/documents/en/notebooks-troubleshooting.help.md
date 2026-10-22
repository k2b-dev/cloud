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
- **Format cannot be printed:** Use JPEG, PNG, WebP or GIF. External addresses must return an image in one of these formats. SVG files stay available as downloads.
- **File could not be read:** Open the file to check it, then export it again and attach the new copy.
- **File too large:** Attach a smaller image. The notebook's attachment limit also applies to external images.
- **No room left in the PDF:** Use smaller images or split the note. Images share **Max input bytes** with the document; an administrator can raise that budget. Large images print at 300, 200 or 150 dpi.
- **Preparation took too long:** Try again, or use fewer or smaller images. Preparing images gets the same time as the PDF renderer, at most 115 seconds; an administrator can raise the renderer **Timeout**.
- **Address not allowed:** The address is not public, does not use HTTPS, or contains a user name or password. Use a public HTTPS image address or attach the image.
- **Address not reachable:** The server could not reach the address, the host answered with an error, or it redirected. Check that the address opens in a browser, try again later, or attach the image.
:::

## Check updates {icon="refresh"}

**Write** synchronizes the note text with other editors. Saved changes refresh query previews and Book content. **Read-only** does not receive shared text edits. Reload it after the saved source changes.

If **Write** stops syncing, for example because your session ended or the note was deleted, the note stays on screen and becomes read-only. The bar under the note says whether your changes are saved. Use **Sign in again** to continue editing after you sign in. Otherwise, use **Copy text** before you **Reload**. If changes are not saved, Notebooks asks before you leave the note.

If a Book page cannot refresh, its last readable content stays visible, and you can try again. If your access ends or the page disappears, Notebooks stops showing the old content and checks the page again. Without JavaScript, reload the page to see changes.
