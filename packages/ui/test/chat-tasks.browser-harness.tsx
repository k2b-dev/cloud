import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { Chat, type ChatTask } from "../src/index";

declare global {
  interface Window {
    __setTasks: (items: ChatTask[]) => void;
    __setOpen: (open: boolean) => void;
    __setPaused: (paused: boolean) => void;
  }
}

const statusLabels = { pending: "Open", in_progress: "In progress", completed: "Done", cancelled: "Dropped" } as const;

const plan: ChatTask[] = [
  { id: "write", content: "Write the change", status: "in_progress" },
  { id: "check", content: "Check what it may do", status: "pending" },
  { id: "examples", content: "Try the examples", status: "pending" },
  { id: "submit", content: "Submit the version", status: "pending" },
];

function Fixture() {
  const [items, setItems] = createSignal<ChatTask[]>(plan);
  const [open, setOpen] = createSignal(true);
  const [paused, setPaused] = createSignal(false);
  window.__setTasks = setItems;
  window.__setOpen = setOpen;
  window.__setPaused = setPaused;
  const counted = () => items().filter((item) => item.status !== "cancelled");
  const done = () => counted().filter((item) => item.status === "completed").length;
  return (
    // The conversation is anchored at the bottom, as in the chat: the plan opens upwards from the composer.
    <main
      id="chat"
      style={{ display: "flex", "flex-direction": "column", "justify-content": "flex-end", height: "640px", width: "min(764px, 100%)" }}
    >
      <p id="last-message">Last message</p>
      <Chat.Tasks
        items={items()}
        open={open()}
        onOpenChange={setOpen}
        paused={paused()}
        label={done() === counted().length ? "All tasks done" : "Tasks"}
        progressLabel={`${done()} of ${counted().length}`}
        statusLabels={statusLabels}
      />
      <div id="composer" style={{ height: "80px", "margin-top": "8px", border: "2px solid #c4519f", "border-radius": "14px" }} />
      <section id="still">
        <p id="still-label">Already done</p>
        <Chat.TaskList
          aria-labelledby="still-label"
          statusLabels={statusLabels}
          items={[
            { id: "a", content: "Wrote the change", status: "completed" },
            { id: "b", content: "Checked what it may do", status: "completed" },
            { id: "c", content: "Try the examples", status: "pending" },
            { id: "d", content: "Export as PDF", status: "cancelled" },
          ]}
        />
      </section>
    </main>
  );
}

render(() => <Fixture />, document.getElementById("root")!);
