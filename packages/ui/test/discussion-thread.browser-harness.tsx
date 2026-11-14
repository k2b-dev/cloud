import { createSignal, For } from "solid-js";
import { render } from "solid-js/web";
import { Avatar, Discussion } from "../src/index";

declare global {
  interface Window {
    __failNext: boolean;
  }
}

type Entry = { id: string; name: string; initials: string; role?: string; time: string; text: string };

const entry = (item: Entry) => (
  <Discussion.Item
    avatar={<Avatar name={item.name} initials={item.initials} size="sm" />}
    author={item.name}
    meta={item.role}
    timestamp={item.time}
  >
    {item.text}
  </Discussion.Item>
);

function Thread(props: { id: string; initial: Entry[]; writing?: boolean; placeholder: string }) {
  const [entries, setEntries] = createSignal(props.initial);
  return (
    <div id={props.id}>
      <Discussion.Thread
        label={`Comments ${props.id}`}
        placeholder={props.placeholder}
        hint="Visible with your decision"
        submitLabel="Comment"
        defaultWriting={props.writing}
        onSubmit={(text) => {
          if (window.__failNext) {
            window.__failNext = false;
            throw new Error("The comment was not saved.");
          }
          setEntries((list) => [...list, { id: `n${list.length}`, name: "Jana Probe", initials: "JP", time: "now", text }]);
        }}
      >
        <For each={entries()}>{entry}</For>
      </Discussion.Thread>
    </div>
  );
}

window.__failNext = false;
render(
  () => (
    <main style={{ width: "min(720px, 100%)", padding: "16px", "box-sizing": "border-box" }}>
      <Thread
        id="one"
        placeholder="Reply …"
        initial={[{ id: "a", name: "Ben Schulz", initials: "BS", role: "Cloud admin", time: "20 min ago", text: "Why only unread mails?" }]}
      />
      <p id="after-one">Line 2</p>
      <Thread
        id="many"
        placeholder="Reply …"
        initial={[
          { id: "a", name: "Ben Schulz", initials: "BS", role: "Cloud admin", time: "20 min ago", text: "Every unread mail gets a task, not only a callback request." },
          { id: "b", name: "Jana Probe", initials: "JP", time: "5 min ago", text: "I see it the same way. I will ask for changes." },
          { id: "c", name: "Ben Schulz", initials: "BS", time: "2 min ago", text: "Thanks." },
        ]}
      />
      <p id="after-many">Line 4</p>
      <Thread id="new" placeholder="Comment on line 5 …" writing initial={[]} />
      <p id="after-new">Line 6</p>
    </main>
  ),
  document.getElementById("root")!,
);
