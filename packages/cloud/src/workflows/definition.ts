/**
 * The surface an app declares in `src/workflows.ts`.
 *
 * Today an action exists in three places: a descriptor in the app's
 * `manifest.ts` (what the workflow language accepts), a binder that resolves
 * the written config into domain objects, and an implementation with its own
 * hand-written parameter type. Nothing connects them, so a descriptor and its
 * implementation can disagree and only fail at runtime.
 *
 * Here an action is one declaration. The config schema drives both the
 * language and the implementation's parameter type, so a change to either side
 * is a compile error rather than a production surprise.
 *
 * Mirrors the notifications declaration style deliberately — one file at the
 * app root, with types inferred rather than restated. Workflow worker wiring is
 * explicit; `defineApp` does not consume these declarations.
 */
import type { SQL } from "bun";
import type { WorkflowActionEffect, WorkflowDependency, WorkflowFieldSchema, WorkflowInvocation, WorkflowJsonValue } from "./contracts";

// ─── Config type inference ───────────────────────────────────────────────────

type ObjectSchema = WorkflowFieldSchema & { kind: "object" };

/** Keys whose schema is marked optional, so they become optional properties. */
type OptionalKeys<P extends Record<string, WorkflowFieldSchema>> = {
  [K in keyof P]: P[K] extends { optional: true } ? K : never;
}[keyof P];

/**
 * The TypeScript value a field schema describes.
 *
 * The workflow language needs a runtime schema so the editor can render a form
 * and the compiler can validate what a user wrote; the implementation needs a
 * static type. Deriving the second from the first is what keeps them from
 * drifting.
 */
export type FromFieldSchema<S extends WorkflowFieldSchema> = S extends { kind: "string"; enum: readonly (infer E extends string)[] }
  ? E
  : S extends { kind: "string" }
    ? string
    : S extends { kind: "number" }
      ? number
      : S extends { kind: "boolean" }
        ? boolean
        : S extends { kind: "value" }
          ? WorkflowJsonValue
          : S extends { kind: "array"; items: infer I extends WorkflowFieldSchema }
            ? FromFieldSchema<I>[]
            : S extends { kind: "record"; values: infer V extends WorkflowFieldSchema }
              ? Record<string, FromFieldSchema<V>>
              : S extends { kind: "union"; variants: readonly (infer V extends WorkflowFieldSchema)[] }
                ? FromFieldSchema<V>
                : S extends { kind: "object"; properties: infer P extends Record<string, WorkflowFieldSchema> }
                  ? FromObjectSchema<P>
                  : never;

/**
 * Flattens an intersection into a single object type.
 *
 * Required and optional properties have to be built separately and combined,
 * but the raw `A & B` shows up verbatim in editor tooltips and in every error
 * message. Collapsing it is what makes the inferred config readable at the
 * call site.
 */
type Simplify<T> = { [K in keyof T]: T[K] } & {};

type FromObjectSchema<P extends Record<string, WorkflowFieldSchema>> = Simplify<
  {
    [K in Exclude<keyof P, OptionalKeys<P>>]: FromFieldSchema<P[K]>;
  } & {
    [K in OptionalKeys<P>]?: FromFieldSchema<P[K]>;
  }
>;

// ─── Effect ladder ───────────────────────────────────────────────────────────

/**
 * How an action behaves when a run is replayed after a crash.
 *
 * Named for the property an action author can answer about their own code,
 * not for the mechanism the kernel uses. The one question underneath: if the
 * process dies between performing the effect and recording that it happened,
 * can we tell afterwards?
 *
 * - `pure`          deterministic given inputs and prior outcomes. Note that a
 *                   step which *reads* mutable state is not pure: a replay
 *                   sees something else. This is the classic mistake.
 * - `transactional` commits inside the journal's own transaction, so a crash
 *                   means it did not happen.
 * - `idempotent`    external, but safe to repeat under a key.
 * - `ambiguous`     external and not verifiable in advance. Needs a way to ask
 *                   afterwards, or it escalates to a human.
 */
export type WorkflowEffectClass = "pure" | "transactional" | "idempotent" | "ambiguous";

/** Maps the ladder onto the language-level effect the compiler already knows. */
export const LANGUAGE_EFFECT: Record<WorkflowEffectClass, WorkflowActionEffect> = {
  pure: "pure",
  transactional: "transactional",
  idempotent: "durable-intent",
  ambiguous: "ambiguous-external",
};

/** Whether a class may be re-executed when a replay finds no recorded outcome. */
export const isReplayable = (effect: WorkflowEffectClass): boolean => effect !== "ambiguous";

// ─── Action outcomes ─────────────────────────────────────────────────────────

/**
 * How a failure is described to the run.
 *
 * `code` is what an operator reads in the run view to tell "the template was
 * deleted" from "you may not do this"; a message alone reads the same in both
 * cases. `retryable` says the attempt failed, not the work — the runtime then
 * retries the step instead of ending the run, and a mail provider being briefly
 * unreachable stops costing a run.
 */
type WorkflowActionFailure = { message: string; code?: string; retryable?: boolean };

/**
 * What an action reports back.
 *
 * `ambiguous` is a first-class result rather than a thrown error: "the send may
 * have gone through" is not a failure, and treating it as one either loses
 * messages or sends them twice. `waiting` means no effect happened; an action
 * that may already have acted must report `ambiguous` instead.
 */
export type WorkflowActionResult<Output> =
  | { state: "succeeded"; output: Output }
  | { state: "waiting"; dependency: WorkflowDependency }
  | ({ state: "failed" } & WorkflowActionFailure)
  | ({ state: "ambiguous"; evidence?: WorkflowJsonValue } & WorkflowActionFailure);

/** What a dry run reports: what *would* happen, without doing it. */
export type WorkflowPlannedEffect = {
  /** Human-readable summary shown in the dry-run view. */
  summary: string;
  /** Counts consumed from the effect budget, keyed by budget dimension. */
  consumes?: Record<string, number>;
  /**
   * What the step would produce.
   *
   * Later steps plan against it, so a dry run of a whole plan stays useful past
   * its first impure step. Mark synthetic values as such — a downstream step
   * that cannot tell a planned record from a real one will act on a fiction.
   */
  output?: WorkflowJsonValue;
  /** Why the plan is not fully determined — surfaced in the dry-run view. */
  issues?: string[];
};

/** Result of asking an external system whether an ambiguous effect landed. */
export type WorkflowReconcileResult<Output> =
  | { state: "succeeded"; output: Output }
  | ({ state: "failed" } & WorkflowActionFailure)
  | ({ state: "unknown" } & WorkflowActionFailure);

// ─── Action context ──────────────────────────────────────────────────────────

export type WorkflowActionContext = {
  /** Identifies the run this step belongs to, for logging and correlation. */
  runId: string;
  /** Identifies the step within the run. Stable across replays. */
  stepKey: string;
  /**
   * What started this run: who it acts as, what it was given, and the app's own
   * context from the event.
   *
   * An action that touches anything permissioned needs the actor, and one that
   * works inside a scope — a base, a mailbox — reads it from the context the
   * emitter attached. Without this every implementation would have to re-read
   * the run to find out who it is.
   */
  invocation: WorkflowInvocation;
  /**
   * The identity the compiler pinned for a config path, relative to this step.
   *
   * A source names a table or a template by the name a person typed; publishing
   * resolves that to an id and freezes it in the plan. Reading the name again at
   * run time would follow a rename to a different object, which is the whole
   * reason binding happens once, at publish.
   */
  binding(...path: Array<string | number>): WorkflowJsonValue | undefined;
  /**
   * Resolves a value reference the config names — `record: order` — to the value
   * it stands for.
   *
   * Distinct from the resolved config: a reference is not an expression, so it
   * survives config resolution verbatim and the action decides what it must be.
   */
  resolveReference(reference: string, ...path: Array<string | number>): Promise<WorkflowJsonValue | undefined>;
  /** Current named workflow values, including outputs saved by earlier steps. */
  variableSnapshot(): Record<string, WorkflowJsonValue>;
  /**
   * The transaction a transactional action runs in.
   *
   * Present only for that class, and it is the whole meaning of the class: the
   * work and the record that it happened commit together, so a crash leaves
   * neither. Do the work on this handle, not on the ambient connection.
   */
  tx?: SQL;
  /** Stable across replays of the same step — the key an idempotent effect uses. */
  effectKey: string;
  /** Keeps a long-running action's lease alive. Pass the application's current
   * transaction to fence its writes against cancellation and worker takeover
   * until commit. Do not call an ambient heartbeat while holding that fence. */
  heartbeat(tx?: SQL): Promise<void>;
};

// ─── Action definition ───────────────────────────────────────────────────────

type RunHook<Config, Output> = (ctx: WorkflowActionContext, config: Config) => Promise<WorkflowActionResult<Output>>;
/**
 * Re-checks permission at the moment of the effect.
 *
 * Access can be revoked between the run being queued and the step running, and
 * for a transactional action the check has to happen on the same handle as the
 * work or it is checking a world the write will not see.
 */
type AuthorizeHook<Config> = (ctx: WorkflowActionContext, config: Config) => Promise<boolean>;
type PlanHook<Config> = (ctx: WorkflowActionContext, config: Config) => Promise<WorkflowPlannedEffect>;

/**
 * `NoInfer` because `run` alone defines what an action produces. Reconcile
 * only answers whether that output already landed, so letting it propose its
 * own candidate is wrong on the contract — and, in practice, inferring one
 * type variable from two hooks at once exceeded the checker's recursion depth.
 */
type ReconcileHook<Output> = (ctx: WorkflowActionContext, effectKey: string) => Promise<WorkflowReconcileResult<NoInfer<Output>>>;

export type WorkflowActionDefinition<Effect extends WorkflowEffectClass, Schema extends ObjectSchema, Output> = {
  label: string;
  description: string;
  effect: Effect;
  /** Drives the language, the editor form, and the implementation's parameter type. */
  config: Schema;
  /** Named output type for the language, when other steps reference this result. */
  outputType?: string;
  run: RunHook<FromFieldSchema<Schema>, Output>;
  /** What a dry run reports. Required for everything that leaves the process. */
  plan?: PlanHook<FromFieldSchema<Schema>>;
  /** Asks afterwards whether an ambiguous effect landed. */
  reconcile?: ReconcileHook<Output>;
  /** Re-checks permission at the moment of the effect, on the effect's own handle. */
  authorize?: AuthorizeHook<FromFieldSchema<Schema>>;
};

/** The fields every action declares, whatever its effect class. */
type ActionBase<Schema extends ObjectSchema> = {
  label: string;
  description: string;
  config: Schema;
  outputType?: string;
};

/**
 * Declares one action, picking the factory that matches its effect class.
 *
 * The class decides which hooks are mandatory: a pure action cannot reconcile
 * because there is nothing to reconcile, an ambiguous one must or an
 * interrupted run has no way back, and anything that leaves the process must
 * plan or a dry run silently under-reports. Naming the class at the call site
 * makes each of those a concrete parameter type rather than a conditional one,
 * so a missing hook is reported as a missing property — and the config type
 * still flows into `run` without being restated.
 *
 * (The conditional-type version of this was also, in the literal sense,
 * uncheckable: resolving a single call exceeded the compiler's recursion
 * depth, because `WorkflowFieldSchema` is recursive.)
 */
export const workflowAction = {
  /** Deterministic given inputs and prior outcomes. Reading mutable state is not pure. */
  pure: <const Schema extends ObjectSchema, Output = void>(
    definition: ActionBase<Schema> & {
      run: RunHook<FromFieldSchema<Schema>, Output>;
    },
  ): WorkflowActionDefinition<"pure", Schema, Output> => ({ ...definition, effect: "pure" }),

  /** Commits inside the journal's transaction, so a crash means it did not happen. */
  transactional: <const Schema extends ObjectSchema, Output = void>(
    definition: ActionBase<Schema> & {
      run: RunHook<FromFieldSchema<Schema>, Output>;
      plan: PlanHook<FromFieldSchema<Schema>>;
      authorize?: AuthorizeHook<FromFieldSchema<Schema>>;
    },
  ): WorkflowActionDefinition<"transactional", Schema, Output> => ({ ...definition, effect: "transactional" }),

  /** External, but safe to repeat under `ctx.effectKey`. */
  idempotent: <const Schema extends ObjectSchema, Output = void>(
    definition: ActionBase<Schema> & {
      run: RunHook<FromFieldSchema<Schema>, Output>;
      plan: PlanHook<FromFieldSchema<Schema>>;
      authorize?: AuthorizeHook<FromFieldSchema<Schema>>;
    },
  ): WorkflowActionDefinition<"idempotent", Schema, Output> => ({ ...definition, effect: "idempotent" }),

  /** External and not verifiable in advance, so it must be answerable afterwards. */
  ambiguous: <const Schema extends ObjectSchema, Output = void>(
    definition: ActionBase<Schema> & {
      run: RunHook<FromFieldSchema<Schema>, Output>;
      plan: PlanHook<FromFieldSchema<Schema>>;
      reconcile: ReconcileHook<Output>;
      authorize?: AuthorizeHook<FromFieldSchema<Schema>>;
    },
  ): WorkflowActionDefinition<"ambiguous", Schema, Output> => ({ ...definition, effect: "ambiguous" }),
};

// ─── App module ──────────────────────────────────────────────

/**
 * An action with its config type erased — the view the kernel works against.
 *
 * `FromFieldSchema` may only be instantiated with a *literal* schema. Applied
 * to the `WorkflowFieldSchema` union itself it never terminates, because the
 * union is recursive: an object's properties are again the full union. So the
 * erased form is spelled out rather than derived, and it is the honest shape
 * anyway — at runtime the kernel holds a schema it validates against and a
 * config it cannot know statically.
 *
 * Declaration sites keep their precise types: `workflowAction` infers them, and
 * a map of such calls stays inferred as its concrete literal type.
 */
export type ErasedWorkflowAction = {
  label: string;
  description: string;
  effect: WorkflowEffectClass;
  config: ObjectSchema;
  outputType?: string;
  run: RunHook<never, unknown>;
  plan?: PlanHook<never>;
  reconcile?: ReconcileHook<unknown>;
  authorize?: AuthorizeHook<never>;
};

export type WorkflowActionMap = Record<string, ErasedWorkflowAction>;
