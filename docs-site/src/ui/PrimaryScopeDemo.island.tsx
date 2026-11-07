import { Button, Checkbox, ChoiceSlider, ContextMenu, Dropdown, openFloatingWindow, prompts, Switch, Tabs, TextInput } from "@k2b/ui";
import { createSignal } from "solid-js";

export function PrimaryScopeControls() {
  const [enabled, setEnabled] = createSignal(true);
  const [checked, setChecked] = createSignal(true);
  const [tab, setTab] = createSignal("notes");
  const [level, setLevel] = createSignal("balanced");
  const [text, setText] = createSignal("");
  return (
    <div style={{ display: "grid", gap: "20px" }}>
      <div style={{ display: "flex", "flex-wrap": "wrap", gap: "12px", "align-items": "center" }}>
        <Button onClick={() => void prompts.confirm("These are fictional demo notes.", { title: "Save notes?" })}>Save notes</Button>
        <Button
          variant="secondary"
          onClick={() =>
            openFloatingWindow(
              (close) => (
                <div>
                  <p>{text() || "Untitled note"}</p>
                  <Button onClick={close}>Close preview</Button>
                </div>
              ),
              { title: "Note preview" },
            )
          }
        >
          Preview
        </Button>
        <Button variant="text" onClick={() => setTab("sources")}>
          Open source
        </Button>
        <Button disabled>Unavailable</Button>
      </div>
      <Tabs
        ariaLabel="Note views"
        value={tab()}
        onValueChange={setTab}
        options={[
          { value: "notes", label: "Notes" },
          { value: "sources", label: "Sources" },
        ]}
      />
      <TextInput label="Name" placeholder="Focus this field" value={text()} onValueChange={setText} />
      <Checkbox label="Include sources" value={checked()} onValueChange={setChecked} />
      <Switch label="Suggest a next step" value={enabled()} onValueChange={setEnabled} />
      <ChoiceSlider
        aria-label="Detail level"
        value={level()}
        onValueChange={setLevel}
        options={[
          { value: "fast", label: "Quick" },
          { value: "balanced", label: "Balanced" },
          { value: "thorough", label: "Thorough" },
        ]}
      />
      <Dropdown.Root items={[{ label: "New note", variant: "accent", action: () => setText("New note") }]}>
        <Dropdown.Trigger variant="secondary">More actions</Dropdown.Trigger>
      </Dropdown.Root>
      <ContextMenu label="Note menu" items={[{ label: "Select note", variant: "accent", action: () => setText("Selected note") }]}>
        <p>Right-click here for the note menu.</p>
      </ContextMenu>
    </div>
  );
}

export default function PrimaryScopeDemo() {
  return (
    <section
      data-k2b-primary="ai"
      aria-label="AI primary controls"
      style={{ padding: "24px", background: "var(--k2b-surface)", color: "var(--k2b-text)" }}
    >
      <PrimaryScopeControls />
    </section>
  );
}
