import { createSignal, For } from "solid-js";
import { render } from "solid-js/web";
import { ChoiceSlider, type ChoiceSliderOption } from "../src/inputs/ChoiceSlider";

const levels: ChoiceSliderOption[] = [
  { value: "fast", label: "Fast", description: "When speed matters" },
  { value: "balanced", label: "Balanced", description: "For most tasks" },
  { value: "thorough", label: "Thorough", description: "For complex tasks" },
  { value: "maximum", label: "Maximum", description: "For the hardest questions" },
];
const withUnavailable = levels.map((level) =>
  level.value === "thorough" ? { ...level, description: undefined, disabledReason: "Budget used up until Monday" } : level,
);

const cases = [
  { name: "normal", options: levels, value: "balanced" },
  { name: "unavailable", options: withUnavailable, value: "balanced" },
  { name: "warning", options: withUnavailable, value: "thorough" },
  { name: "no-knob", options: levels, value: null },
] as const;

function Case(props: { size: "md" | "lg"; name: string; options: readonly ChoiceSliderOption[]; value: string | null }) {
  const [value, setValue] = createSignal<string | null>(props.value);
  return (
    <section class="case" data-case={`${props.size}-${props.name}`} data-size={props.size}>
      <p class="case-label">{props.name}</p>
      <ChoiceSlider
        aria-label="Model, from fast to thorough"
        options={props.options}
        value={value}
        onValueChange={setValue}
        description="Own choice"
        size={props.size}
      />
      <span class="after" />
    </section>
  );
}

render(
  () => (
    <For each={["md", "lg"] as const}>
      {(size) => (
        <div class="column" data-column={size}>
          <For each={cases}>{(item) => <Case size={size} {...item} />}</For>
        </div>
      )}
    </For>
  ),
  document.getElementById("root")!,
);
