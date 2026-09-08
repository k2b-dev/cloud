---
title: Author and publish workflows
navTitle: Author workflows
section: Automation
order: 680
description: Build a workflow definition and publish a version that can be executed.
tags: [workflows, authoring, publication]
updated: 2026-08-05
---

# Author and publish workflows

An application defines the language its users can author. It compiles and binds
source before publishing an immutable version.

Offline authoring tools can build the same language manifest with
`createWorkflowManifest()` from `@valentinkolb/cloud/workflows/language`.
Pass the language identity, limits, inputs, triggers, and an `actions` map with
each action's `label`, `description`, `config`, `effect`, and optional
`outputType`. Keep that metadata in a module without server imports and reuse
it in the executable action declarations. This lets a CLI show the complete
workflow reference without initializing application services.

## Define actions and runtime event names

```ts
import { workflowAction } from "@valentinkolb/cloud/workflows";

export const INVENTORY_EVENT = {
  itemChanged: "inventory.itemChanged",
} as const;

export const INVENTORY_ACTIONS = {
  loadItem: workflowAction.pure({
    label: "Load item",
    description: "Loads the item captured by the workflow.",
    config: {
      kind: "object",
      properties: {
        item: { kind: "string" },
      },
    },
    run: async (_ctx, input) => ({
      state: "succeeded",
      output: { itemId: input.item },
    }),
  }),
};
```

Workflow schemas are serializable `WorkflowFieldSchema` objects. They are not
Zod schemas. The editor and compiler need the schema at runtime.

Action config supports string, number, boolean, value, array, record, union,
and object fields. Keep the schema as a literal so TypeScript can infer the
handler input.

Action names are local keys. Runtime event names are application-owned
constants. Namespace them with the app ID, such as `inventory.itemChanged`.
The durable emitter accepts those names and payloads; the workflow module
describes only the triggers users can author.

## Choose an effect class

| Factory | Promise | Required hooks |
| --- | --- | --- |
| `pure` | Output is deterministic from inputs and prior outcomes | `run` |
| `transactional` | Work commits in the journal transaction | `run`, `plan` |
| `idempotent` | External work is safe to repeat under `effectKey` | `run`, `plan` |
| `ambiguous` | External work may need later verification | `run`, `plan`, `reconcile` |

A database read of mutable state is not pure. A replay can return a different
value.

`authorize` may re-check permission immediately before an effect. Other
validation belongs in `run` so its failure keeps a useful code.

## Define one workflow module

The module is the application's single workflow declaration. It combines the
executable actions with the authoring language:

```ts
import { defineWorkflowModule } from "@valentinkolb/cloud/workflows";

export const inventoryWorkflows = defineWorkflowModule({
  id: "inventory",
  version: 1,
  inputs: [
    {
      kind: "text",
      label: "Text",
      description: "A text value supplied to the workflow.",
      valueType: "core.string",
      config: {
        kind: "object",
        properties: {
          required: { kind: "boolean", optional: true },
        },
      },
    },
  ],
  triggers: [
    {
      kind: "itemChanged",
      label: "Item changed",
      description: "Starts when an inventory item changes.",
      eventValues: { itemId: "core.string" },
      config: { kind: "object", properties: {} },
    },
  ],
  actions: INVENTORY_ACTIONS,
  limits: {
    maxInputs: 20,
    maxSteps: 200,
    maxDepth: 20,
    maxConditions: 200,
    maxConditionDepth: 20,
    maxLoopItems: 500,
  },
});
```

`defineWorkflowModule()` derives action descriptors from the executable action
definitions and adds the core variable, success, and failure actions. The
generated `inventoryWorkflows.manifest` is JSON-only. Cloud hashes that exact
artifact when compiling and binding an immutable workflow version.
Pass the module itself to compiler, binder, editor, and runtime helpers; the
manifest is a serialized artifact, not a separate authoring API.

Runtime events and authorable triggers are separate. An application may emit
internal or direct-invocation events that users cannot select in YAML, and one
authorable trigger may adapt a differently named runtime event. Keep runtime
names as explicit application constants instead of adding declarations the
emitter never reads.

Set limits before accepting source. Changing the language requires a new
manifest version.

## Compile and bind

The source uses strict YAML. It may only use inputs, triggers, actions, and
limits declared by the manifest:

```yaml
inputs:
  itemId:
    type: text
    required: true
triggers:
  itemChanged:
    with:
      itemId: "${{ trigger.itemId }}"
steps:
  - loadItem:
      itemId: "${{ inputs.itemId }}"
```

Compile before binding:

```ts
import {
  bindWorkflow,
  compileWorkflow,
} from "@valentinkolb/cloud/workflows/language";

export const compileAndBindInventoryWorkflow = async (
  source: string,
) => {
  const compiled = await compileWorkflow(
    source,
    inventoryWorkflows,
  );
  if (!compiled.ok) return compiled;

  const plan = await bindWorkflow(
    compiled.ir,
    inventoryWorkflows,
    async (ir) => {
      const catalog = await loadInventoryWorkflowCatalog();
      return {
        catalog,
        bindings: await bindInventoryReferences(ir, catalog),
      };
    },
  );
  return { ok: true as const, plan };
};
```

Compilation validates YAML, fields, references, and limits. It returns
source-located diagnostics instead of throwing for invalid user input.

The binder converts mutable names into stable application IDs. Its `catalog`
is hashed into the plan. Its `bindings` are available to actions through
`ctx.binding()`.

Return compiler diagnostics to the editor. Convert application catalog or
binding failures into equally clear editor errors. Do not publish an invalid
plan.

The worker uses the same module for application actions:

```ts
import { createWorkflowActionPort } from "@valentinkolb/cloud/workflows/store";

const actions = createWorkflowActionPort(inventoryWorkflows);
```

The runtime port remains application-wired because authorization and text
rendering belong to the application, including for independently deployed
workflow providers.

## Publish one version

Create the workflow identity once. Then publish immutable versions:

```ts
import type {
  WorkflowBoundPlan,
} from "@valentinkolb/cloud/workflows";
import {
  createWorkflow,
  publishWorkflowVersion,
  type WorkflowActivationInput,
} from "@valentinkolb/cloud/workflows/store";

const activationsFor = (
  plan: WorkflowBoundPlan,
): WorkflowActivationInput[] =>
  plan.triggers.map((trigger, index) => ({
    key: `${trigger.kind}:${index}`,
    eventType: `inventory.${trigger.kind}`,
    config: { ...trigger.config, with: trigger.with },
  }));

const validation = await compileAndBindInventoryWorkflow(source);
if (!validation.ok) throw new Error("workflow source is invalid");
const boundPlan = validation.plan;

const workflow = await createWorkflow(
  {
    appId: "inventory",
    scopeId: warehouseId,
    key: "restock",
    name: "Restock inventory",
    author: { kind: "user", id: actor.id },
  },
  { db: transaction },
);

await publishWorkflowVersion(
  {
    workflowId: workflow.id,
    source,
    plan: boundPlan,
    author: { kind: "user", id: actor.id },
    activations: activationsFor(boundPlan),
    authorization: authorizationSnapshot,
  },
  { db: transaction },
);
```

Publication writes the version and replaces its activations in one transaction.
An event cannot fall into a gap between old and new activations.

Activation keys must remain stable for the same logical trigger. Event types
are application contracts; the workflow kernel does not derive them.

Each run pins the active version when its event is recorded. Publishing later
does not change that run.

Set `activate: false` for a stored draft that must not become live.

The application owns workflow names and app-specific profile data. Store that
data in the same transaction as kernel publication.

Use [Start workflow runs](/en/docs/automation/emit-events-and-start-runs) after
publication.
