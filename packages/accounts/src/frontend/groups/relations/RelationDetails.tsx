import type { GroupRelations } from "@k2b/cloud/contracts";
import { ButtonLink, NoticeCard } from "@k2b/ui";
import { For, type JSX, Show } from "solid-js";
import type { RelationsText } from "./relations-messages";

type Props = {
  relations: GroupRelations;
  t: RelationsText;
  /** Renders a group name in a list as the control that selects it: a link on the page, a button in the tree. */
  pick: (id: string, name: string) => JSX.Element;
  /** Set where the selection can become the focus. */
  focusHref?: string;
};

/** Details of the selected group: kind, direct members, cycle, and its relations. Never lists member names. */
export default function RelationDetails(props: Props) {
  const name = (id: string) => props.relations.nodes.find((node) => node.id === id)?.name ?? id;
  const selected = () => props.relations.selected;
  const node = () => props.relations.nodes.find((entry) => entry.id === selected()?.id);
  const list = (label: string, entries: { ids: string[]; total: number } | null) => (
    <Show when={entries}>
      {(current) => (
        <section class="mt-4">
          <h3 class="mb-1 text-xs font-semibold text-dimmed">{label}</h3>
          <Show when={current().total > 0} fallback={<p class="text-sm text-dimmed">{props.t.none}</p>}>
            <ul class="flex flex-col">
              <For each={current().ids}>{(id) => <li class="min-w-0">{props.pick(id, name(id))}</li>}</For>
            </ul>
            <Show when={current().total > current().ids.length}>
              <p class="text-xs text-dimmed">{props.t.andMore({ count: current().total - current().ids.length })}</p>
            </Show>
          </Show>
        </section>
      )}
    </Show>
  );
  return (
    <Show when={selected() && node()} fallback={<p class="mt-4 text-sm text-dimmed">{props.t.choose}</p>}>
      <div class="text-sm">
        <h2 class="truncate text-base font-semibold text-primary">{node()!.name}</h2>
        <p class="text-xs text-dimmed">
          {node()!.provider === "ipa" ? "FreeIPA" : props.t.local} · {props.t.directMembers({ count: node()!.members })}
        </p>
        <Show when={selected()!.cycle}>
          {(cycle) => (
            <NoticeCard class="mt-3" tone="warning" icon="ti ti-refresh-alert" title={props.t.cycleTitle}>
              {props.t.cycleText({ path: cycle().path.map(name).join(" → "), size: cycle().size })}
              {node()!.provider === "ipa" ? ` ${props.t.cycleIpa}` : ""}
            </NoticeCard>
          )}
        </Show>
        <Show when={selected()!.managerCycle}>
          {(cycle) => (
            <NoticeCard class="mt-3" tone="warning" icon="ti ti-refresh-alert" title={props.t.managerCycleTitle}>
              {props.t.managerCycleText({ path: cycle().path.map(name).join(" → ") })}
            </NoticeCard>
          )}
        </Show>
        {list(props.t.containedIn({ count: selected()!.parents.total }), selected()!.parents)}
        {list(props.t.contains({ count: selected()!.children.total }), selected()!.children)}
        {list(props.t.managesList({ count: selected()!.manages?.total ?? 0 }), selected()!.manages)}
        {list(props.t.managedBy({ count: selected()!.managedBy?.total ?? 0 }), selected()!.managedBy)}
        <div class="mt-4 flex flex-wrap gap-2">
          <ButtonLink size="sm" variant="secondary" href={`/app/accounts/groups/${selected()!.id}`}>
            {props.t.openGroup}
          </ButtonLink>
          <Show when={props.focusHref}>
            {(href) => (
              <ButtonLink size="sm" variant="secondary" href={href()}>
                {props.t.makeFocus}
              </ButtonLink>
            )}
          </Show>
        </div>
      </div>
    </Show>
  );
}
