import { CODE_SECRET_ERRORS, type CodeToolFailure } from "@k2b/cloud/ai/browser";
import { valueAllowed } from "@k2b/cloud/browser/code-secrets";
import type { SecretPerson } from "@k2b/cloud/shared";
import { LIMITS } from "./contracts";

export type SecretRequestInput = {
  name: string;
  origin: string;
  header: string;
  prefix: string;
  target?: { code: string; pathPrefix: string };
};
export type SecretRequestBinding = { origin: string; pathPrefix: string; headers: string[]; prefix?: string };
export type SecretRequestEntry = {
  revision: string;
  configured: boolean;
  binding: SecretRequestBinding;
  valueSetAt: string | null;
  valueSetBy: SecretPerson | null;
};
export type SecretRequestResult = { configured: boolean; name: string } | CodeToolFailure;
export type SecretRequestFailure = { ok: false; code: string; status: number | null };
export type SecretRequestPorts = {
  list(): Promise<{ ok: true; entry: SecretRequestEntry | null; title?: string | null } | SecretRequestFailure>;
  check(binding: SecretRequestBinding): Promise<boolean | null>;
  save(input: { value: string; revision: string | null; binding?: SecretRequestBinding }): Promise<{ ok: true } | SecretRequestFailure>;
};
type Facts = {
  target: { code: string } | null;
  title: string | null;
  mode: "chat" | "code";
  name: string;
  binding: SecretRequestBinding;
  existing: SecretRequestEntry | null;
};
type Field = Facts & { value: string; revealed: boolean };
type States<Name extends string, Data> = { [State in Name]: Data & { state: State } }[Name];
/** The mockup's 33 scenes are combinations of these states, mode, existing.configured and revealed. */
export type SecretRequestState =
  | States<"checking" | "held", Facts>
  | States<
      | "open"
      | "entered"
      | "replace"
      | "saving"
      | "empty"
      | "characters"
      | "too-long"
      | "save-failed"
      | "no-answer"
      | "conflict"
      | "refreshing",
      Field
    >
  | (Field & { state: "not-saved"; reason: "bad-input" | "rejected" | "destination-refused" | "check-failed" })
  | States<"saved" | "declined" | "expired" | "access-lost" | "outcome-unknown", Facts>
  | (Facts & { state: "unavailable"; reason: "editor-required" | "destination-refused" | "check-failed" | "list-failed" });

const failure = (error: string, guidance?: string): CodeToolFailure => ({ failed: true, error, ...(guidance ? { guidance } : {}) });
const editorRequired = () =>
  failure(
    CODE_SECRET_ERRORS.editorRequired,
    "Only people who can edit this automation may enter its secret. Ask an editor; never ask for the value in chat.",
  );
const equalBinding = (a: SecretRequestBinding, b: SecretRequestBinding) =>
  a.origin === b.origin &&
  a.pathPrefix === b.pathPrefix &&
  a.prefix === b.prefix &&
  a.headers.length === b.headers.length &&
  a.headers.every((header, i) => header === b.headers[i]);

/** Window-local, headless state. Subscribers must never persist or log a field state. */
export function createSecretRequest(input: SecretRequestInput, ports: SecretRequestPorts) {
  const facts: Facts = {
    target: input.target ? { code: input.target.code } : null,
    title: null,
    mode: input.target ? "code" : "chat",
    name: input.name,
    existing: null,
    binding: {
      origin: input.origin,
      pathPrefix: input.target?.pathPrefix ?? "/",
      headers: [input.header],
      ...(input.target ? {} : { prefix: input.prefix }),
    },
  };
  // Only after a card showed: Cloud answers "not found" alike for lost rights and a deleted automation, so no reason.
  const accessFailure = () =>
    failure(
      CODE_SECRET_ERRORS.accessLost,
      input.target
        ? "Only people who can edit this automation may enter its secret. Ask an editor; never ask for the value in chat."
        : "Sign in again, then ask for a new secret request. Never send the value in chat.",
    );
  let state: SecretRequestState = { ...facts, state: "checking" };
  let ended = false;
  // Only a request that may have reached the store makes the outcome unknown; the destination check before it does not.
  let writing = false;
  const listeners = new Set<(state: SecretRequestState) => void>();
  let resolve!: (result: SecretRequestResult) => void;
  const result = new Promise<SecretRequestResult>((done) => {
    resolve = done;
  });
  const emit = (next: SecretRequestState) => {
    state = next;
    for (const listener of listeners) listener(state);
  };
  const finish = (next: "saved" | "declined" | "expired" | "access-lost" | "outcome-unknown", result: SecretRequestResult) => {
    if (ended) return;
    ended = true;
    emit({ ...facts, state: next });
    resolve(result);
  };
  const unavailable = (reason: Extract<SecretRequestState, { state: "unavailable" }>["reason"], result: CodeToolFailure) => {
    if (ended) return;
    ended = true;
    emit({ ...facts, state: "unavailable", reason });
    resolve(result);
  };
  const field = (): Field | null => ("value" in state ? state : null);
  const editable = () => field() !== null && state.state !== "saving" && state.state !== "refreshing";
  const read = async () => {
    try {
      return await ports.list();
    } catch {
      return { ok: false as const, code: "UNAVAILABLE", status: null };
    }
  };
  const check = async () => {
    try {
      return await ports.check(facts.binding);
    } catch {
      return null;
    }
  };
  const start = async () => {
    if (state.state !== "checking" || ended) return;
    const listed = await read();
    if (ended || state.state !== "checking") return;
    if (!listed.ok)
      return unavailable(
        listed.code === "FORBIDDEN" || listed.code === "NOT_FOUND" ? "editor-required" : "list-failed",
        listed.code === "FORBIDDEN" || listed.code === "NOT_FOUND" ? editorRequired() : failure(CODE_SECRET_ERRORS.listFailed),
      );
    facts.existing = listed.entry;
    facts.title = listed.title ?? null;
    if (input.target) {
      const allowed = await check();
      if (ended) return;
      if (allowed !== true)
        return unavailable(
          allowed === false ? "destination-refused" : "check-failed",
          failure(allowed === false ? CODE_SECRET_ERRORS.destinationRefused : CODE_SECRET_ERRORS.checkFailed),
        );
    }
    emit({ ...facts, state: facts.existing?.configured ? "replace" : "open", value: "", revealed: false });
  };
  const refresh = async (value: string, revealed: boolean, conflict: boolean) => {
    emit({ ...facts, state: "refreshing", value, revealed });
    const listed = await read();
    if (ended) return false;
    if (!listed.ok) {
      if (listed.code === "NOT_FOUND" || listed.code === "FORBIDDEN" || listed.status === 401 || listed.status === 403)
        finish("access-lost", accessFailure());
      else emit({ ...facts, state: "no-answer", value, revealed });
      return false;
    }
    const previous = facts.existing;
    facts.existing = listed.entry;
    // A conflict adopts the current destination. Never undo another editor's binding change.
    const changedTarget = Boolean(input.target && listed.entry && !equalBinding(facts.binding, listed.entry.binding));
    if (input.target && listed.entry) facts.binding = listed.entry.binding;
    const changed =
      previous?.revision !== listed.entry?.revision ||
      previous?.configured !== listed.entry?.configured ||
      previous?.valueSetAt !== listed.entry?.valueSetAt;
    emit({
      ...facts,
      state: conflict || changedTarget ? "conflict" : listed.entry?.configured ? "replace" : value ? "entered" : "open",
      value,
      revealed,
    });
    return !changed && !changedTarget;
  };
  const send = async (confirmed: boolean) => {
    const current = field();
    if (!current || !editable() || ended) return;
    if ((state.state === "replace" || state.state === "conflict") && !confirmed) return;
    const value = current.value;
    const allowed = input.target ? valueAllowed(value) : /^[\x20-\x7e\x80-\xff]+$/.test(value);
    if (!value || !allowed || (!input.target && value.length > LIMITS.text)) {
      emit({ ...facts, state: !value ? "empty" : !allowed ? "characters" : "too-long", value, revealed: current.revealed });
      return;
    }
    emit({ ...facts, state: "saving", value, revealed: current.revealed });
    if (input.target) {
      const allowed = await check();
      if (ended) return;
      if (allowed !== true) {
        emit({
          ...facts,
          state: "not-saved",
          reason: allowed === false ? "destination-refused" : "check-failed",
          value,
          revealed: current.revealed,
        });
        return;
      }
    }
    let written: Awaited<ReturnType<SecretRequestPorts["save"]>>;
    writing = true;
    try {
      written = await ports.save({
        value,
        revision: facts.existing?.revision ?? null,
        ...(!facts.existing || !equalBinding(facts.binding, facts.existing.binding) ? { binding: facts.binding } : {}),
      });
    } catch {
      written = { ok: false, code: "UNAVAILABLE", status: null };
    } finally {
      writing = false;
    }
    if (ended) return;
    if (written.ok) return finish("saved", { configured: true, name: input.name });
    if (written.code === "CONFLICT" || written.code === "HTTP_CONFLICT" || written.status === 409) {
      await refresh(value, current.revealed, true);
      return;
    }
    if (written.code === "NOT_FOUND" || written.code === "FORBIDDEN" || written.status === 401 || written.status === 403)
      return finish("access-lost", accessFailure());
    if (written.code === "BAD_INPUT" || (input.target && written.status !== null && written.status < 500)) {
      emit({
        ...facts,
        state: "not-saved",
        reason: written.code === "BAD_INPUT" ? "bad-input" : "rejected",
        value,
        revealed: current.revealed,
      });
      return;
    }
    emit({
      ...facts,
      state: input.target ? "no-answer" : "save-failed",
      value,
      revealed: current.revealed,
    });
  };
  return {
    get state() {
      return state;
    },
    result,
    start,
    subscribe(listener: (state: SecretRequestState) => void) {
      listeners.add(listener);
      listener(state);
      return () => {
        listeners.delete(listener);
      };
    },
    input(value: string) {
      if (editable() && !ended) {
        const current = field()!;
        emit({
          ...facts,
          state: state.state === "conflict" ? "conflict" : facts.existing?.configured ? "replace" : value ? "entered" : "open",
          value,
          revealed: current.revealed,
        });
      }
    },
    reveal() {
      const current = state;
      if ("value" in current && editable() && !ended) {
        emit({ ...current, revealed: !current.revealed });
      }
    },
    submit: () => send(false),
    async replace() {
      const current = field();
      if (!current || !editable() || ended) return;
      if (state.state === "conflict") {
        await refresh(current.value, current.revealed, true);
        if (state.state !== "conflict") return;
      }
      await send(true);
    },
    async retry() {
      const current = field();
      if (!current || !editable() || ended) return;
      if (!(await refresh(current.value, current.revealed, false))) return;
      // An existing value needs explicit replacement after an uncertain answer; metadata cannot prove who saved it.
      if (facts.existing?.configured) return;
      await send(false);
    },
    decline() {
      if (editable() && !ended) finish("declined", { configured: false, name: input.name });
    },
    held() {
      if (!ended && state.state !== "saving") emit({ ...facts, state: "held" });
    },
    expire() {
      if (writing) {
        finish(
          "outcome-unknown",
          failure(
            CODE_SECRET_ERRORS.unknown,
            "Check the current secret metadata before trying again. No entry was replayed; never send the value in chat.",
          ),
        );
        return;
      }
      finish("expired", failure(CODE_SECRET_ERRORS.expired));
    },
    complete(result: SecretRequestResult) {
      if ("configured" in result) finish(result.configured ? "saved" : "declined", { configured: result.configured, name: input.name });
      else finish("expired", failure(CODE_SECRET_ERRORS.incomplete));
    },
  };
}
export type SecretRequestController = ReturnType<typeof createSecretRequest>;
