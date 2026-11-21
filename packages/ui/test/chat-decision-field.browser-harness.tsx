import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { Chat, ChatDecisionField, type ChatDecisionFieldProps, type ChatDecisionState } from "../src/index";

// A question that asks for one value, in every state it can take while it stays open. Fictional data.
// `running` presses the main answer, whose promise never settles: the question holds it by itself, without `disabled`.
export type FieldState = "open" | "typed" | "saving" | "empty" | "chars" | "failed" | "unknown" | "held" | "conflict" | "running";

declare global {
  interface Window {
    __set: (state: FieldState) => void;
    __close: () => void;
  }
}

const lines: ChatDecisionFieldProps["lines"] = {
  safe: { text: "Not in the chat history; nobody in Cloud sees the value again.", icon: "ti ti-shield-lock" },
  held: { text: "Open in another window. Answer there.", icon: "ti ti-devices" },
  empty: { text: "Paste the key first.", icon: "ti ti-alert-circle", tone: "danger" },
  chars: { text: "A character does not work here (“…”). Copy the whole key.", icon: "ti ti-alert-circle", tone: "danger" },
  failed: { text: "Saving failed. Try again; your value stays in the field.", icon: "ti ti-alert-circle", tone: "danger" },
  unknown: { text: "No answer from Cloud, maybe saved. Trying again checks first.", icon: "ti ti-help-circle", tone: "warning" },
  conflict: { text: "Changed meanwhile. Use your value anyway?", icon: "ti ti-alert-triangle", tone: "warning" },
};

const save = { label: "Save securely", icon: "ti ti-lock" };
const faces = {
  save,
  saving: { label: "Saving …", icon: "ti ti-loader-2 k2b-spin" },
  retry: { label: "Try again", icon: "ti ti-refresh" },
  force: { label: "Replace anyway" },
};

const table: Record<FieldState, { value: string; line: string; face: keyof typeof faces; invalid?: boolean; disabled?: boolean }> = {
  open: { value: "", line: "safe", face: "save" },
  typed: { value: "pk_live_FICTIONAL_7f3Q", line: "safe", face: "save" },
  saving: { value: "pk_live_FICTIONAL_7f3Q", line: "safe", face: "saving", disabled: true },
  empty: { value: "", line: "empty", face: "save", invalid: true },
  chars: { value: "pk_live_FICTIONAL…", line: "chars", face: "save", invalid: true },
  failed: { value: "pk_live_FICTIONAL_7f3Q", line: "failed", face: "retry" },
  unknown: { value: "pk_live_FICTIONAL_7f3Q", line: "unknown", face: "retry" },
  held: { value: "", line: "held", face: "save", disabled: true },
  conflict: { value: "pk_live_FICTIONAL_9Rb2", line: "conflict", face: "force" },
  running: { value: "pk_live_FICTIONAL_7f3Q", line: "safe", face: "saving" },
};

function Fixture() {
  const [state, setState] = createSignal<FieldState>("open");
  const [decision, setDecision] = createSignal<ChatDecisionState>("open");
  const [value, setValue] = createSignal("");
  const row = () => table[state()];
  window.__set = (next) => {
    setState(next);
    setValue(table[next].value);
    if (next === "running") document.querySelector<HTMLButtonElement>(".k2b-chat-decision__confirm")!.click();
  };
  window.__close = () => setDecision("decided");
  return (
    <main>
      <Chat.Decision
        state={decision()}
        kind={{ label: "Secret", icon: "ti ti-key" }}
        sentence={
          <>
            Add <strong>Parcel_API</strong>?
          </>
        }
        entry={
          <ChatDecisionField
            facts={[
              { text: "Stays only for you in this chat until you remove it", icon: "ti ti-message-circle" },
              { text: "Goes only to api.parcel.example; every request with it asks you first", icon: "ti ti-world" },
            ]}
            label="Value for Parcel_API"
            value={value()}
            onValueChange={setValue}
            placeholder="Paste the key"
            revealLabel="Show value"
            lines={lines}
            current={row().line}
            invalid={row().invalid}
            disabled={row().disabled}
            confirm={{
              ...faces[row().face],
              alternates: Object.values(faces),
              onSelect: () => (state() === "running" ? new Promise<void>(() => {}) : undefined),
            }}
            decline={{ label: "Decline", onSelect: () => {} }}
          />
        }
        outcome={<Chat.Outcome current="done" lines={{ done: { tone: "done", text: "Secret Parcel_API saved", time: "19:42" } }} />}
      />
      <p id="sentinel">The next conversation paragraph stays in place.</p>
    </main>
  );
}

render(() => <Fixture />, document.getElementById("root")!);
