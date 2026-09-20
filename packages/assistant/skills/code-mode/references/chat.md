# Interactive visualizations in chat

Use one-off code for a chart, calculator, report or dashboard that belongs to
this answer. Sliders, buttons, tables and charts use the same `ui` API as Apps.

1. Load `code_run`, `code_inspect`, `code_interact` and `code_present`.
2. Run the source and inspect its real values. Exercise relevant controls.
3. Wait for ready, error-free UI with no pending work or modal.
4. Call `code_present({runId,title})`. Only successful presentation delivers
   visible content. You may stop the test run afterwards.

```js
// code_run({code: "..."}) entry:
export default () => {
  const total = ui.stat({label: "Total", value: 20});
  ui.slider({id: "quantity", label: "Quantity", min: 1, max: 20, value: 2,
    onChange: value => total.setValue(value * 10)});
};
```

Use the actual API examples in the UI reference for callbacks and updates.
`code_present` takes the returned runId and a concise title. It accepts one-off
code without a saved App id or resourceId. Use `code_open` for saved Apps.

Presentation saves source, full UI preview and copies of the selected input
versions in the conversation. Each presentation is immutable. Changing the
original input file does not change this saved input. If an input changed before
presentation, start and verify a fresh run. Keep large source data in explicit
inputPaths rather than retyping truncated tool output. The per-chat presentation
budget is 250 MiB including source, previews and input copies; ordinary per-file
and runtime message limits apply.

Opening chat history only shows the saved preview. The user chooses Interact
to start the program from its entry point; previous slider values and execution
state are not restored. Put external actions in explicit callbacks, never in
initialization. Startup should build the useful default view from retained data.
Cloud capabilities and HTTP calls keep their normal permission and approval
checks. Chat visualizations have no App database or shared storage.

Users can download the current view as PDF or static HTML, and individual charts
as SVG. Exports preserve filter values, sources and data timestamps, omit action
buttons, and render complete current tables. A download does not create a chat
file. If the agent must hand off an actual file, use the existing file workflow.

Name the delivered visualization and state whether the data is a retained
snapshot or explicitly loaded live. Do not invent a retrieval timestamp.
