import { Chat, type DictationEvent, type DictationSource, SegmentedControl } from "@k2b/ui";
import { createSignal } from "solid-js";
import { DemoCard } from "../DemoCard";

type Outcome = "speak" | "blocked" | "interrupted" | "quota" | "busy" | "elsewhere" | "countdown";

const words = "We move the stand setup to Thursday because the floor panels only arrive on Wednesday evening.".split(" ");

/** A scripted source: it speaks a sentence word by word, or answers with the chosen notice. */
const scriptedSource = (outcome: () => Outcome): DictationSource => ({
  devices: async () => [
    { id: "default", label: "Built-in microphone" },
    { id: "headset", label: "Headset" },
  ],
  start: ({ signal }) => {
    const queue: DictationEvent[] = [];
    let wake: (() => void) | undefined;
    let ended = false;
    const push = (event: DictationEvent) => {
      queue.push(event);
      wake?.();
    };
    const timers: ReturnType<typeof setTimeout>[] = [];
    const cleanup = () => {
      ended = true;
      for (const timer of timers) clearTimeout(timer);
    };
    const later = (ms: number, run: () => void) => timers.push(setTimeout(run, ms));
    signal.addEventListener("abort", () => {
      cleanup();
      wake?.();
    });
    const chosen = outcome();
    const codes = { blocked: "microphone_blocked", quota: "daily_limit", busy: "overloaded", elsewhere: "busy_elsewhere" } as const;
    if (chosen in codes)
      later(300, () => push({ type: "error", code: codes[chosen as keyof typeof codes], retryable: chosen !== "quota" }));
    else {
      push({ type: "state", state: "connecting" });
      later(300, () =>
        push({
          type: "state",
          state: "live",
          maxMs: chosen === "countdown" ? 70_000 : 600_000,
          device: { id: "default", label: "Built-in microphone" },
        }),
      );
      const level = setInterval(() => push({ type: "level", level: Math.random() * 0.9 }), 100);
      timers.push(level);
      words.forEach((word, index) => later(600 + index * 280, () => push({ type: "text", text: `${index ? " " : ""}${word}` })));
      if (chosen === "interrupted") later(600 + 6 * 280, () => push({ type: "error", code: "connection_lost", retryable: true }));
    }
    return {
      events: {
        async *[Symbol.asyncIterator]() {
          // Every way out, a finish, an error or the reader leaving, stops the script's timers.
          try {
            while (!ended) {
              const event = queue.shift();
              if (!event) {
                await new Promise<void>((done) => (wake = done));
                continue;
              }
              yield event;
              if ((event.type === "state" && event.state === "finished") || event.type === "error") return;
            }
          } finally {
            cleanup();
          }
        },
      },
      stop: () =>
        new Promise<void>((done) => {
          push({ type: "state", state: "finishing" });
          later(800, () => {
            push({ type: "state", state: "finished" });
            done();
          });
        }),
    };
  },
});

export function DictationDemo() {
  const [outcome, setOutcome] = createSignal<Outcome>("speak");
  const [draft, setDraft] = createSignal("Write a short mail to Jana: ");
  return (
    <DemoCard
      id="dictation"
      chip={{ kind: "component", name: "ChatComposer dictation", from: "@k2b/ui" }}
      description="Press the microphone. The scripted source speaks a sentence word by word at the caret; Stop finishes with the last words, ✕ removes only the dictated words. Choose what the next start answers to see each notice."
      code={`<ChatComposer
  value={draft()}
  onValueChange={setDraft}
  onSubmit={send}
  dictation={{ source: createLiveDictationSource({ app: "my-app" }) }}
/>`}
    >
      <SegmentedControl
        size="sm"
        ariaLabel="Next start"
        value={outcome}
        onValueChange={setOutcome}
        options={[
          { value: "speak", label: "Speak" },
          { value: "countdown", label: "Last minute" },
          { value: "interrupted", label: "Interrupted" },
          { value: "blocked", label: "Blocked" },
          { value: "quota", label: "Allowance" },
          { value: "busy", label: "Busy" },
          { value: "elsewhere", label: "Other tab" },
        ]}
      />
      <Chat.Composer
        value={draft()}
        onValueChange={setDraft}
        onSubmit={() => {
          setDraft("");
        }}
        dictation={{
          source: scriptedSource(outcome),
          alternative: { label: "Record instead", note: "Try again in a moment or record; the recording is kept.", run: () => undefined },
        }}
      />
    </DemoCard>
  );
}
