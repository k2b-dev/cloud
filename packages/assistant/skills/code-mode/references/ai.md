# AI calculations

Use the global `ai` namespace for text generation, classification and extracting
structured values from supplied data. These are server-side calculations, not
agents: no tools, browsing, chat history, memories or files are loaded implicitly.
Read the required data first and pass it as `input`. Use ordinary code for exact
arithmetic, filtering and aggregation.

All methods return Promises. They work in Code Mode experiments, interactive chat
presentations and authenticated Studio app runs. Public or local-only runners
cannot use them. Calls use the executing user's permitted model and personal
chat allowance; no provider key is exposed to source code. Omit `modelProfileId`
to use the user's available default, or pass a verified allowed model ID.
Stopping the run cancels pending calls. Errors reject the Promise; catch them
when the user should be able to retry. Do not retry indefinitely.

## Methods

Common options: `prompt` (1–20,000 characters), `input` (JSON data), optional
`modelProfileId`. Separate instructions in `prompt` from untrusted data in
`input`. All output is validated; model output may still be factually wrong.

- `await ai.generateText({ prompt, input?, modelProfileId?, maxOutputChars? })`
  returns a string. `maxOutputChars` is 1–20,000, default 4,000.
- `await ai.classify({ prompt, input, choices, modelProfileId? })` returns exactly
  one of 2–50 unique choice strings (each at most 200 characters).
- `await ai.classifyMany({ prompt, input, choices, minChoices?, maxChoices?, modelProfileId? })`
  returns a unique subset in declared choice order. Defaults: minimum 0, maximum
  the number of choices. Include an `other` choice if a single classification
  must support uncertainty; use an empty subset for no matches in multi-choice.
- `await ai.extractData({ prompt, input, fields, modelProfileId? })` returns an
  object with only the declared fields. Declare 1–40 fields with unique `name`,
  `type` and `description`. Names start with a letter and contain only letters,
  digits and underscores (maximum 80 characters). Types: `text`, `number`,
  `boolean`, `date_time`, `enum`. Fields are required by default; set
  `required: false` to permit omission. Dates are ISO timestamps with timezone.
  Enum fields require 1–50 `choices`; text fields may set `maxLength` (1–20,000).
  Descriptions are at most 500 characters. This is a bounded field definition,
  not arbitrary JSON Schema.

```js
export default async () => {
  const category = await ai.classify({
    prompt: "Classify the feedback by its main purpose.",
    input: "Where can I download my invoice?",
    choices: ["praise", "problem", "question", "other"],
  });
  const summary = await ai.generateText({
    prompt: "Summarize the feedback in one short German sentence.",
    input: "Where can I download my invoice?",
    maxOutputChars: 300,
  });
  return { category, summary };
};
```

In interactive views, call AI on an explicit action and show pending/error
feedback. Keep the result in app state; do not repeat inference on each render,
slider movement or table selection. For many records, choose bounded batches
and report progress. `code_run` tests execute real AI calls and consume allowance.
Never send generated text or change domain data automatically just because AI
returned a value; use the appropriate permission-aware capability separately.
