# Use published App actions

For an existing procedure, load only `code_list`, `code_actions` and
`code_action`. Find an App with `code_list({q})`, then discover its contract with
`code_actions({id})`. Discovery returns `{id,publishedVersion,revision,actions}`;
each action has `name`, `title`, `description`, `entry`, `inputSchema` and
`outputSchema`. Discovery does not execute source code.

Call `code_action({id,action,publishedVersion,input})` using the exact discovered
name and publication. Input must match its JSON Schema. The result is the normal
run snapshot: `runId`, `status`, `output` (JSON text), `outputTruncated`, `logs`,
`files`, `work` and optional error or modal. Output is checked against the
published output schema when execution completes. Use `code_inspect` for a
running job, `code_export` for captured files, and `code_stop` to release a run.
A pending modal follows the normal `code_interact` contract.

Use access is enough for a published action. It gives no draft, publication, or
administration rights. A changed or withdrawn publication rejects the call;
rediscover before deciding whether to retry. A rejected input has not executed.
An execution error, timeout, or invalid output can follow successful effects:
inspect saved state rather than blindly replaying a mutation. Actions use normal
capability and HTTP approvals. They cannot approve those calls themselves.

An action receives only its explicit JSON input and its App's normal runtime
APIs. It does not receive the chat's files implicitly. No management references
or tools are needed merely to call an existing action.

## Publish an action

Read [Source workflow](source-workflow.md) for source editing. Save
`app.actions.json` alongside the handler modules in one `code_write` revision:

```json
{
  "actions": [{
    "name": "double",
    "title": "Double a number",
    "description": "Return twice the supplied number.",
    "entry": "double.ts",
    "inputSchema": {
      "type": "object",
      "properties": {"value": {"type": "number"}},
      "required": ["value"],
      "additionalProperties": false
    },
    "outputSchema": {"type": "number"}
  }]
}
```

`double.ts`:

```js
export default ({ value }) => value * 2;
```

Names match `[a-z][a-zA-Z0-9_]*` (maximum 80 characters) and are unique. Each
handler is a relative `.js` or `.ts` file that default-exports a function accepting
one input argument. Titles are 1–120 characters; descriptions 1–2000 characters.
The manifest accepts 1–64 actions and no other fields. Schemas use the same JSON
Schema support as Cloud capabilities; unsupported features reject publication.
The normal source byte and file budgets also include the manifest.

An App can have GUI, actions, or both. An action-only App may omit the source's
GUI entry file (normally `main.ts`); no empty dashboard is needed. Persistence is
optional: this example has no database. Each action is compiled at publication
without evaluating it. Code, manifest, and schemas publish together. Calling the
published action does not start the GUI entry. Use `code_run({id})` to test the
GUI. For an unpublished handler, discover with `code_actions({id,draft:true})`
and call `code_action({id,action,revision,input})` using its exact draft revision.
This requires Manage. Supply either `revision` or `publishedVersion`, never both.
Test effects remain real. After testing, publish and use its `publishedVersion`.

CLI: `assistant code actions ID` discovers the same metadata. Run
`assistant code action --chat CHAT --input-file call.json`, where `call.json`
contains `{id,action,publishedVersion,input}`. Normal explicit capability approval
flags and follow-up inspection/export steps work as for `assistant code run`.

`code_list` exposes `publishedVersion` for identifying a release. Published
`code_actions` returns `publishedVersion` and no working `revision`; draft
discovery returns `revision` for the draft call. Never use `publishedRevision`
(the source revision included in a release) as the working revision.
Invalid manifests and handler compilation return `COMPILE_FAILED` with a source
diagnostic. Fix App source; do not change otherwise valid tool arguments.
