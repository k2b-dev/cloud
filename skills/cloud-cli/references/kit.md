# Kit

Use `cld kit` to create and share browser tools. Start with `cld kit help` and
`cld kit sdk --json`. Scripts run in the browser; the CLI manages their source
and permissions.

1. `cld kit init ./tool` creates a local CSV converter and history starter.
2. Edit the `.js` files and `kit.json`. Each `*.script.js` defines a navigation
   item with `export default kit.script({ name, run() {} })`.
3. `cld kit validate ./tool` checks metadata and relative imports without running code.
4. `cld kit push ./tool --json` creates the app and records its short ID and
   revision. Later pushes use that revision to prevent lost updates.
5. Open the returned `/app/kit/<id>` path in Cloud to use the saved app.

Use `list`, `get` and `pull <id> <new-directory>` to inspect existing apps.
Use `access list`, `access grant`, `access set`, and `access revoke` for canonical
Cloud sharing; inspect each command's help before a mutation. Read permission
shows metadata, write allows use and source access, admin allows editing and
sharing. Local browser results are not shared with app recipients.

A stale push fails with `REVISION_CONFLICT`. Pull into a separate directory and
reconcile changes before pushing. `delete <id> --yes` removes the app and its
grants; use it only with explicit deletion authorization.

For workbench layouts use `ui.workbench` with `controls`, `content` and a
`footer` containing status/actions. Compose `ui.section`, `ui.filePicker`,
`ui.table` and `ui.list` handles. `ui.markdown`, `ui.link` and `ui.linkButton`
provide formatted content and user navigation. The SDK output is the complete
signature reference. Use mode initializes the selected tool automatically.
