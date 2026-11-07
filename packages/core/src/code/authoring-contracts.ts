import { CODE_CHECK_LIMITS, CodeCheckResultSchema, CodeTestCaseSchema, CodeTestMockSchema, CodeTestResultSchema } from "@k2b/cloud/code";
import { CodeCheckedVersionManifestSchema } from "@k2b/cloud/contracts";
import { AppEventEnvelopeSchema } from "@k2b/cloud/events";
import { z } from "zod";
import { codeActivationContracts } from "./activation-contracts";
import { CodeIdSchema, type CodeOwner, CodeOwnerSchema, CodeSchema, CodeSourceFilesSchema, codeQueryContracts } from "./contracts";
import { codePolicyContracts } from "./policy-contracts";
import { codeSchedulingContracts } from "./scheduling-contracts";
import { codeSecretContracts } from "./secret-contracts";
import { CodeVersionDiffFileSchema, codeVersionContracts } from "./version-contracts";

/** Schedule returned by init for personal CLI and chat checkouts. */
export const CODE_INITIAL_SOURCE =
  'import { app } from "@sdk";\n\napp.schedule("0 8 * * 1", async () => {\n}, { name: "monday" });\nexport default app;\n';
/** Resource- and app-owned Code starts with a signed-in page. */
export const CODE_INITIAL_PAGE_SOURCE = `import { app, jsx, Page, Stats, Section, Chart, Table, Form } from "@sdk";

// Example figures: replace them with data from your SDK calls.
app.get("/", c => c.page(
  <Page title="Overview" subtitle="Example data" icon="ti ti-layout-dashboard">
    <Stats items={[
      { label: "Open", value: 12, delta: { value: 0.2, better: "down" }, compare: { label: "Last week", value: 10 } },
      { label: "Done this week", value: 34, delta: { value: 0.133, better: "up" }, compare: { label: "Last week", value: 30 } },
      { label: "On time", value: 0.92, format: { style: "percent" }, delta: { value: 0.04, unit: "points", better: "up" },
        compare: { label: "Last week", value: 0.88 } },
    ]} />
    <Section title="This week" icon="ti ti-calendar-week" color="blue">
      <Chart.Bar width="twoThirds" title="Done per day" data={[
        { label: "Mon", value: 6 }, { label: "Tue", value: 8 }, { label: "Wed", value: 5 },
        { label: "Thu", value: 9 }, { label: "Fri", value: 6 },
      ]} />
      <Form width="third" title="Add an item" action="/items" submit="Add"
        fields={[{ type: "text", name: "title", label: "Title", required: true }]} />
      <Table title="Latest" columns={[{ key: "title", label: "Title" }, { key: "status", label: "Status" }]}
        rows={[{ title: "Order chairs", status: "Open" }, { title: "Fix the lamp", status: "Done" }]} empty="Nothing yet." />
    </Section>
  </Page>
));
app.post("/items", c => {
  // Save the item with an SDK call here, then show the page again.
  return c.redirect("/");
});
export default app;
`;
/** Personal Code starts with a schedule; it may add routes, which run with its owner's mandate. */
export function codeInitialFiles(owner: CodeOwner) {
  const entry = owner.kind === "person" ? "code.ts" : "code.tsx";
  return { entry, files: { [entry]: owner.kind === "person" ? CODE_INITIAL_SOURCE : CODE_INITIAL_PAGE_SOURCE } };
}
/** Local editor checking uses the same description-only JSX factory as the checker. */
export const CODE_PROJECT_TSCONFIG = {
  compilerOptions: {
    target: "ESNext",
    module: "ESNext",
    moduleResolution: "Bundler",
    strict: true,
    noEmit: true,
    jsx: "react",
    jsxFactory: "jsx",
    paths: { "@sdk": ["./sdk/sdk.d.ts"] },
  },
  include: ["**/*.ts", "**/*.tsx"],
  exclude: ["sdk"],
};
/** Versioned local code.json. IDs determine folders; title and owner remain metadata. Never stores credentials. */
export const CodeProjectSchema = z
  .object({
    version: z.literal(1),
    codeId: CodeIdSchema,
    title: z.string().min(1).max(200),
    owner: CodeOwnerSchema,
    entry: z.string().default("code.ts"),
    baseVersionId: z.uuid().nullable(),
  })
  .strict();
export type CodeProject = z.infer<typeof CodeProjectSchema>;
/** Stable CLI/chat failure, including the complete C8 comparison on a stale push. No stack or process identity. */
export const CodeAuthoringErrorSchema = z
  .object({
    version: z.literal(1),
    error: z.object({ code: z.string(), message: z.string(), details: z.json().nullable() }).strict(),
  })
  .strict();
export type CodeAuthoringError = z.infer<typeof CodeAuthoringErrorSchema>;
/** Permission presentation from live authorized readers; unavailable titles are null, never guessed. */
export const CodeAuthoringPermissionSchema = z
  .object({
    operation: z.string(),
    target: z.object({ type: z.string(), id: z.string().nullable() }).strict().nullable(),
    title: z.string().nullable(),
    typeTitle: z.string().nullable(),
    own: z.boolean(),
    file: z.string(),
    line: z.number().int().positive(),
    /** Sorted entrypoints whose handler makes this call, as the checker placed it; absent when it could not. */
    entrypoints: z.array(z.string().min(1)).min(1).optional(),
    status: z.enum(["new", "existing"]),
  })
  .strict();
export type CodeAuthoringPermission = z.infer<typeof CodeAuthoringPermissionSchema>;
const source = z
  .object({ codeId: CodeIdSchema, files: CodeSourceFilesSchema, entry: z.string().min(1).max(512).default("code.ts") })
  .strict();
const check = z
  .object({
    version: z.literal(1),
    result: CodeCheckResultSchema,
    manifest: CodeCheckedVersionManifestSchema.nullable(),
    permissions: z.array(CodeAuthoringPermissionSchema),
  })
  .strict();
const pulled = z.object({ version: z.literal(1), config: CodeProjectSchema, files: CodeSourceFilesSchema }).strict();
const submitted = z
  .object({
    version: z.literal(1),
    submission: codeVersionContracts.submit.data,
    /** Which version keeps running meanwhile; null when none runs. Added field: consumers may ignore it. */
    runningVersion: z.number().int().positive().nullable().optional(),
  })
  .strict();
/** Local source compared with its saved base and the current server version. No filesystem paths. */
export const CodeLocalStatusSchema = z
  .object({
    code: CodeSchema,
    permission: z.enum(["reader", "editor"]),
    baseVersionId: z.uuid().nullable(),
    baseCurrent: z.boolean(),
    modified: z.boolean(),
    latest: codeVersionContracts.submit.data.nullable(),
  })
  .strict();
/** Stable aggregate for every discovered local code.json, ordered by Code ID. */
export const CodeWorkspaceStatusSchema = z.object({ version: z.literal(1), items: z.array(CodeLocalStatusSchema) }).strict();
/** Single source of truth for C18 CLI and C19 chat tools. Success values are printed unchanged by --json.
 * v1 has no elapsed times or machine paths. Test/simulate reuse C17's deterministic fake-only result verbatim.
 * HTTP authoring endpoints use POST /api/code/authoring/<key>; failures use CodeAuthoringErrorSchema.
 */
export const codeAuthoringContracts = {
  init: {
    input: z.object({ title: z.string().min(1).max(200), owner: CodeOwnerSchema.optional() }).strict(),
    data: pulled,
  },
  pull: { input: z.object({ codeId: CodeIdSchema }).strict(), data: pulled },
  pullAll: {
    input: z.object({ cursor: CodeIdSchema.optional() }).strict(),
    data: z.object({ version: z.literal(1), items: z.array(pulled), nextCursor: CodeIdSchema.nullable() }).strict(),
  },
  status: {
    input: z.object({ config: CodeProjectSchema, files: CodeSourceFilesSchema }).strict(),
    data: CodeWorkspaceStatusSchema,
  },
  runs: { input: codeQueryContracts.runList.input, data: codeQueryContracts.runList.data.extend({ version: z.literal(1) }) },
  runRead: { input: codeQueryContracts.runRead.input, data: codeQueryContracts.runRead.data.extend({ version: z.literal(1) }) },
  pause: { input: codeVersionContracts.pause.input, data: codeVersionContracts.pause.data.extend({ version: z.literal(1) }) },
  resume: { input: codeVersionContracts.resume.input, data: codeVersionContracts.resume.data.extend({ version: z.literal(1) }) },
  policyRead: { input: codePolicyContracts.read.input, data: codePolicyContracts.read.data.extend({ version: z.literal(1) }) },
  policyEffective: {
    input: codePolicyContracts.effective.input,
    data: codePolicyContracts.effective.data.extend({ version: z.literal(1) }),
  },
  policyPreview: { input: codePolicyContracts.preview.input, data: codePolicyContracts.preview.data.extend({ version: z.literal(1) }) },
  policyUpdate: { input: codePolicyContracts.update.input, data: codePolicyContracts.update.data.extend({ version: z.literal(1) }) },
  secretSet: { input: codeSecretContracts.set.input, data: codeSecretContracts.set.data.extend({ version: z.literal(1) }) },
  secretList: { input: codeSecretContracts.list.input, data: codeSecretContracts.list.data.extend({ version: z.literal(1) }) },
  secretDelete: { input: codeSecretContracts.delete.input, data: codeSecretContracts.delete.data.extend({ version: z.literal(1) }) },
  secretCheck: {
    input: codeSecretContracts.checkBinding.input,
    data: codeSecretContracts.checkBinding.data.extend({ version: z.literal(1) }),
  },
  sdk: {
    input: z.object({ codeId: CodeIdSchema }).strict(),
    data: z.object({ version: z.literal(1), files: CodeSourceFilesSchema }).strict(),
  },
  check: { input: source, data: check },
  test: { input: source.extend({ tests: CodeSourceFilesSchema, trace: z.boolean().default(false) }), data: CodeTestResultSchema },
  simulate: {
    input: source.extend({ fixture: CodeTestCaseSchema, trace: z.boolean().default(false) }),
    data: CodeTestResultSchema,
  },
  simulateEvent: {
    input: z
      .object({ codeId: CodeIdSchema, versionId: z.uuid(), event: AppEventEnvelopeSchema, mocks: z.array(CodeTestMockSchema).max(100) })
      .strict(),
    data: CodeTestResultSchema,
  },
  push: { input: source.extend({ baseVersionId: z.uuid().nullable(), tests: CodeSourceFilesSchema.optional() }), data: submitted },
  submit: { input: source.extend({ baseVersionId: z.uuid().nullable(), tests: CodeSourceFilesSchema.optional() }), data: submitted },
  /** Submits the latest source once more, for a page without a local project: it picks up changed secret bindings. */
  resubmit: { input: z.object({ codeId: CodeIdSchema, baseVersionId: z.uuid() }).strict(), data: submitted },
  diff: {
    input: z.object({ codeId: CodeIdSchema, versionId: z.uuid() }).strict(),
    data: z.object({ version: z.literal(1), diff: codeVersionContracts.diff.data }).strict(),
  },
  activate: {
    input: codeActivationContracts.activate.input,
    data: z.object({ version: z.literal(1), activation: codeActivationContracts.activate.data }).strict(),
  },
  run: {
    input: codeSchedulingContracts.start.input.extend({ idempotencyKey: z.string().min(1).max(96) }),
    data: z.object({ version: z.literal(1), run: codeSchedulingContracts.start.data }).strict(),
  },
} as const;
export type CodeAuthoringCommand = keyof typeof codeAuthoringContracts;
export type CodeAuthoringInput<K extends CodeAuthoringCommand> = z.output<(typeof codeAuthoringContracts)[K]["input"]>;
export type CodeAuthoringData<K extends CodeAuthoringCommand> = z.infer<(typeof codeAuthoringContracts)[K]["data"]>;
/** Same request budget as the isolated checker, enforced before parsing on HTTP and before sending local source. */
export const CODE_AUTHORING_REQUEST_BYTES = CODE_CHECK_LIMITS.requestBytes;
/** Complete conflict rows, kept separate from a formatted human diff. */
export const CodeAuthoringConflictSchema = z.object({ latestVersionId: z.uuid().nullable(), files: z.array(CodeVersionDiffFileSchema) });
