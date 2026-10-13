# Show an app in the chat

Computed charts and tables use `cloud.view.*` in the run, then `present({path})`;
read [Views in the chat](views.md). A few non-run values use the `chart` tool.
A chart, table or explorer of computed data needs no app at all. Anything the
person interacts with beyond that, such as a calculator, converter, form or a
chart with its own controls, is a saved Studio App, even when it keeps no data.

`code_open({id})` shows a Studio App beside the chat. `code_present({id})` shows
it as a card in this chat instead, with its data and current source, under its
title unless you pass one; use it when the person asks to see the app in the
chat. The card has a fixed height, starts on a click and offers Open to show
the app beside the chat. Read [HTML apps](apps.md) for the files, styles and
sandbox rules.

Before showing an app, run `code_check` (see [HTML apps](apps.md)).
`code_open` and `code_present` refuse an app without a passing check for its
current files, steps and tables, and `code_present` also refuses static errors
such as CDN scripts, missing imports, inline handlers or network URLs; warnings
come back with the result. A passing check does not judge design or business
logic, so mention what the person can do with the app.

An app that shows computed data gets it from a script: run `code_run` over the
chat files, check the totals, and copy the validated file into the app with
`code_file_copy`, or let the script write the finished module, for example
``cloud.download("data.js", `export const rows = ${JSON.stringify(rows)};`)``,
`code_export` it and import it with `code_import`. Never retype run values into
app source.

`code_present({ title, files })` without an `id` shows a throwaway card that is
not saved as an app and does not appear in Studio. Use it only when the person
explicitly asks for a quick preview they do not want to keep. Its files hold
everything, also its data; it has no database, `cloud.kv` or `cloud.files`.

The card's download menu saves a static copy of the app as it is shown, as HTML
or PDF. The copy runs no scripts. A download does not create a chat file; to
hand a file to the agent or another tool, create it with `cloud.download` in a
script and `code_export` it.

Each presentation stays with its chat; a corrected throwaway card is a new
`code_present` call, while a saved app always shows its current source.
Presentations of a chat share a 250 MiB budget. Cloud capabilities and HTTP
calls from a card keep their normal permission checks and ask the person each
time.
