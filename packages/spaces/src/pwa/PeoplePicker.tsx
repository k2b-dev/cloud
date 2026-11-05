import { Dropdown, type DropdownItem, useLocale } from "@k2b/ui";
import { createSignal, type JSX, onCleanup } from "solid-js";
import type { SpaceAssignableUser, SpaceItemAssignee } from "@/contracts";
import { readAssignable } from "./create";
import { myTasksMessages } from "./messages";

type Props = {
  spaceShortId: string;
  userId: string;
  /** The person, so "Assign to me" works whatever the directory's page holds. */
  me?: SpaceItemAssignee;
  /** Who is chosen now; the picker checks them. */
  selected: readonly SpaceItemAssignee[];
  /** Each choice applies at once; the sheet stays open. */
  onToggle: (person: SpaceItemAssignee, chosen: boolean) => void;
  /** One quiet sentence under the people, such as that each choice saves at once. */
  note?: string;
  disabled?: boolean;
  /** The trigger's content. */
  children: JSX.Element;
  class?: string;
  label: string;
  onOpenChange?: (open: boolean) => void;
  /** `chip` is a small secondary button, as in the quick add; `plain` leaves the look to `class`, as a property row does. */
  appearance?: "chip" | "plain";
};

type Directory = { state: "idle" | "loading" | "failed" | "ready"; people: SpaceAssignableUser[] };

/**
 * The people of a Space to check, with a search on the server over everyone the Space may assign (up to 20 per
 * query) and "Assign to me" on top, which only adds. The directory needs write access, as assigning does; while it
 * loads or fails, the chosen people stay as they are and the sheet says so.
 */
export default function PeoplePicker(props: Props) {
  const locale = useLocale();
  const t = () => myTasksMessages.resolve([locale()]).t;
  const [directory, setDirectory] = createSignal<Directory>({ state: "idle", people: [] });
  const [query, setQuery] = createSignal("");
  let request = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => {
    request += 1;
    clearTimeout(timer);
  });

  const load = async (search: string) => {
    const asked = ++request;
    setDirectory((current) => ({ state: "loading", people: current.people }));
    const people = await readAssignable(props.spaceShortId, search);
    // Only the newest search answers.
    if (asked !== request) return;
    if (!people) return void setDirectory((current) => ({ state: "failed", people: current.people }));
    setDirectory({ state: "ready", people });
  };
  const searchFor = (value: string) => {
    if (value === query()) return;
    setQuery(value);
    clearTimeout(timer);
    timer = setTimeout(() => void load(value.trim()), 200);
  };

  const chosen = (id: string) => props.selected.some((person) => person.id === id);
  const names = () => props.selected.map((person) => person.displayName.split(" ")[0]).join(", ");
  const items = (): DropdownItem[] => {
    const current = directory();
    if (current.state === "loading" && current.people.length === 0)
      return [
        {
          label: t().peopleLoading,
          icon: "ti ti-loader-2 k2b-spin",
          description: names() ? t().peopleStay({ names: names() }) : undefined,
          disabled: true,
        },
      ];
    if (current.state === "failed" && current.people.length === 0)
      return [
        {
          label: t().peopleFailed,
          icon: "ti ti-alert-circle",
          description: names() ? t().peopleStay({ names: names() }) : undefined,
          disabled: true,
        },
        { label: t().retry, icon: "ti ti-reload", closeOnSelect: false, action: () => void load(query().trim()) },
      ];
    const me = props.me ?? current.people.find((person) => person.id === props.userId);
    const people: SpaceItemAssignee[] = [
      // The chosen people stay listed, also when the search does not match them.
      ...props.selected.filter((person) => !current.people.some((entry) => entry.id === person.id)),
      ...current.people,
    ];
    return [
      {
        label: t().assignMe,
        icon: "ti ti-user-plus",
        description: chosen(props.userId) ? t().alreadyAssigned : undefined,
        disabled: chosen(props.userId) || !me,
        closeOnSelect: false,
        action: () => me && props.onToggle(me, true),
      },
      {
        sectionLabel: t().inSpace,
        items: people.map((person) => ({
          label: person.displayName,
          choice: "checkbox" as const,
          checked: () => chosen(person.id),
          description: person.id === props.userId ? t().you : undefined,
          closeOnSelect: false,
          action: () => props.onToggle(person, !chosen(person.id)),
        })),
      },
    ];
  };

  return (
    <Dropdown
      items={items()}
      phone="sheet"
      variant="touch"
      position="bottom-left"
      label={props.label}
      note={props.note}
      disabled={props.disabled}
      onOpenChange={(open) => {
        props.onOpenChange?.(open);
        if (open && directory().state === "idle") void load("");
      }}
      // The search runs on the server; the entries follow its answer.
      search={{
        label: t().findPerson,
        filter: (value) => {
          queueMicrotask(() => searchFor(value));
          return items();
        },
      }}
    >
      <Dropdown.Trigger
        appearance={props.appearance === "chip" ? "button" : "plain"}
        variant={props.appearance === "chip" ? "secondary" : undefined}
        size={props.appearance === "chip" ? "sm" : undefined}
        class={props.class}
        disabled={props.disabled}
        // The directory loads as soon as a finger or the focus reaches the trigger, so it is usually there on opening.
        onPointerDown={() => directory().state === "idle" && void load("")}
        onFocus={() => directory().state === "idle" && void load("")}
      >
        {props.children}
      </Dropdown.Trigger>
    </Dropdown>
  );
}
