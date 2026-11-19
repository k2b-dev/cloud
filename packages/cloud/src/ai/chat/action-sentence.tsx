import { ReferenceChip } from "@k2b/ui";
import { createMemo, For, Match, Switch } from "solid-js";
import type { ActionChip, ActionText } from "./action-card";

function PersonChips(props: { chip: Extract<ActionChip, { kind: "person" }> }) {
  // List words such as ", " and " und " come from the locale; each name is its own chip, the rest stays text.
  const parts = createMemo(() => {
    const names = props.chip.names;
    const items =
      props.chip.rest > 0 ? [...names.map((_, index) => `\u0000${index}`), props.chip.more] : names.map((_, index) => `\u0000${index}`);
    return new Intl.ListFormat(props.chip.locale, { type: "conjunction" }).formatToParts(items).map((part) => {
      const match = part.type === "element" ? /^\u0000(\d+)$/.exec(part.value) : null;
      return match ? { name: names[Number(match[1])]! } : { text: part.value };
    });
  });
  return <For each={parts()}>{(part) => ("name" in part ? <ReferenceChip kind="person" name={part.name ?? ""} /> : part.text)}</For>;
}

const personChip = (chip: ActionChip) => (chip.kind === "person" ? chip : undefined);
const timeChip = (chip: ActionChip) => (chip.kind === "time" ? chip : undefined);
const thingChip = (chip: ActionChip) => (chip.kind === "object" || chip.kind === "place" ? chip : undefined);

/** A sentence of text and typed chips, in the app's colour. */
export function ActionTextView(props: { text: ActionText; accent?: string }) {
  return (
    <For each={props.text}>
      {(part) => (
        <Switch fallback={part.kind === "text" ? part.text : null}>
          <Match when={part.kind === "chip" ? part.chip : undefined}>
            {(chip) => (
              <Switch>
                <Match when={personChip(chip())}>{(person) => <PersonChips chip={person()} />}</Match>
                <Match when={timeChip(chip())}>
                  {(time) => <ReferenceChip kind="time" label={time().label} dateTime={time().dateTime} />}
                </Match>
                <Match when={thingChip(chip())}>
                  {(thing) => (
                    <ReferenceChip
                      kind={thing().kind}
                      title={thing().title}
                      href={thing().href}
                      icon={thing().icon}
                      accent={props.accent}
                      gone={thing().gone}
                    />
                  )}
                </Match>
              </Switch>
            )}
          </Match>
        </Switch>
      )}
    </For>
  );
}
