import { describe, expect, test } from "bun:test";
import type { WorkflowFieldSchema } from "./contracts";
import {
  type FromFieldSchema,
  isReplayable,
  LANGUAGE_EFFECT,
  type WorkflowActionMap,
  type WorkflowActionResult,
  workflowAction,
} from "./definition";

/** Fails to compile unless the two types are identical, not merely assignable. */
type Exact<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const exact = <T extends true>(_proof: T): void => undefined;

describe("FromFieldSchema", () => {
  test("derives primitives", () => {
    exact<Exact<FromFieldSchema<{ kind: "string" }>, string>>(true);
    exact<Exact<FromFieldSchema<{ kind: "number" }>, number>>(true);
    exact<Exact<FromFieldSchema<{ kind: "boolean" }>, boolean>>(true);
  });

  test("narrows a string enum to its literals", () => {
    // A config field with a fixed set of values should type as those values,
    // otherwise the implementation has to re-check what the language already knows.
    exact<Exact<FromFieldSchema<{ kind: "string"; enum: ["move", "copy"] }>, "move" | "copy">>(true);
  });

  test("derives arrays and records", () => {
    exact<Exact<FromFieldSchema<{ kind: "array"; items: { kind: "string" } }>, string[]>>(true);
    exact<Exact<FromFieldSchema<{ kind: "record"; values: { kind: "number" } }>, Record<string, number>>>(true);
  });

  test("makes optional fields optional properties, not just undefined", () => {
    type Config = FromFieldSchema<{
      kind: "object";
      properties: { to: { kind: "string" }; subject: { kind: "string"; optional: true } };
    }>;
    const withoutOptional: Config = { to: "a@b.c" };
    expect(withoutOptional.to).toBe("a@b.c");
    exact<Exact<Config["subject"], string | undefined>>(true);
  });

  test("derives nested objects", () => {
    type Config = FromFieldSchema<{
      kind: "object";
      properties: { target: { kind: "object"; properties: { id: { kind: "string" } } } };
    }>;
    const value: Config = { target: { id: "x" } };
    expect(value.target.id).toBe("x");
  });
});

describe("workflowAction", () => {
  const config = {
    kind: "object",
    properties: { to: { kind: "string" }, retries: { kind: "number", optional: true } },
  } as const satisfies WorkflowFieldSchema & { kind: "object" };

  test("infers the run parameter from the config schema", () => {
    const action = workflowAction.ambiguous({
      label: "Send",
      description: "Sends a thing.",
      config,
      run: async (_ctx, input) => {
        // Inference is the whole point: `to` is a string here without a cast,
        // and a typo in the property name fails the build.
        exact<Exact<typeof input.to, string>>(true);
        exact<Exact<typeof input.retries, number | undefined>>(true);
        return { state: "succeeded", output: { id: input.to } };
      },
      cost: () => ({ sends: 1 }),
      plan: async (_ctx, input) => ({ summary: `send to ${input.to}` }),
      reconcile: async () => ({ state: "unknown", message: "provider did not answer" }),
    });

    expect(action.effect).toBe("ambiguous");
  });

  test("the factory stamps the effect, so it cannot disagree with the hooks", () => {
    // The old shape took `effect` as a field, which let a declaration name one
    // class and provide another's hooks; here the name *is* the class.
    expect(
      workflowAction.pure({ label: "F", description: "F.", config, run: async () => ({ state: "succeeded", output: undefined }) }).effect,
    ).toBe("pure");
    expect(
      workflowAction.idempotent({
        label: "M",
        description: "M.",
        config,
        run: async () => ({ state: "succeeded", output: undefined }),
        plan: async () => ({ summary: "move" }),
      }).effect,
    ).toBe("idempotent");
  });

  test("a pure action needs only run", () => {
    const action = workflowAction.pure({
      label: "Format",
      description: "Formats a value.",
      config,
      run: async (_ctx, input) => ({ state: "succeeded", output: input.to.trim() }),
    });
    exact<Exact<Awaited<ReturnType<typeof action.run>>, WorkflowActionResult<string>>>(true);
  });

  test("a pure action may not declare reconcile", () => {
    workflowAction.pure({
      label: "Format",
      description: "Formats a value.",
      config,
      run: async () => ({ state: "succeeded", output: undefined }),
      // @ts-expect-error — nothing to reconcile when the step never left the process.
      reconcile: async () => ({ state: "unknown", message: "" }),
    });
  });

  test("an ambiguous action must declare reconcile", () => {
    // @ts-expect-error — without reconcile an interrupted run has no way back.
    workflowAction.ambiguous({
      label: "Send",
      description: "Sends a thing.",
      config,
      run: async () => ({ state: "succeeded", output: undefined }),
      plan: async () => ({ summary: "send" }),
    });
  });

  test("a non-pure action must declare plan, or dry run would lie", () => {
    // @ts-expect-error — a dry run that skips this step reports the wrong effects.
    workflowAction.idempotent({
      label: "Move",
      description: "Moves a thing.",
      config,
      run: async () => ({ state: "succeeded", output: undefined }),
    });
  });

  test("reconcile reports the output run defined, and cannot redefine it", () => {
    workflowAction.ambiguous({
      label: "Send",
      description: "Sends a thing.",
      config,
      run: async () => ({ state: "succeeded", output: { id: "1" } }),
      plan: async () => ({ summary: "send" }),
      // @ts-expect-error — a reconciled success has to be the same shape run produces.
      reconcile: async () => ({ state: "succeeded", output: { messageId: "1" } }),
    });
  });

  test("every declaration fits the erased shape the kernel stores", () => {
    // The kernel holds a heterogeneous map and validates config against the
    // schema at runtime; this proves the precise types still fit that view.
    const actions: WorkflowActionMap = {
      format: workflowAction.pure({ label: "F", description: "F.", config, run: async () => ({ state: "succeeded", output: 1 }) }),
      send: workflowAction.ambiguous({
        label: "S",
        description: "S.",
        config,
        run: async () => ({ state: "succeeded", output: { id: "1" } }),
        plan: async () => ({ summary: "send" }),
        reconcile: async () => ({ state: "unknown", message: "" }),
      }),
    };
    expect(Object.keys(actions)).toEqual(["format", "send"]);
  });
});

describe("effect ladder", () => {
  test("only ambiguous effects block replay", () => {
    expect(isReplayable("pure")).toBe(true);
    expect(isReplayable("transactional")).toBe(true);
    expect(isReplayable("idempotent")).toBe(true);
    expect(isReplayable("ambiguous")).toBe(false);
  });

  test("maps onto the effect vocabulary the compiler already knows", () => {
    expect(LANGUAGE_EFFECT.idempotent).toBe("durable-intent");
    expect(LANGUAGE_EFFECT.ambiguous).toBe("ambiguous-external");
  });
});
