import { Combobox, FilterToggle, SegmentedControl, useLocale } from "@k2b/ui";
import { Show } from "solid-js";
import { apiClient } from "@/api/client";
import { usePageSwap } from "@/frontend/lib/page-swap";
import { relationsMessages } from "./relations-messages";
import { type RelationsUrlState, relationsHref } from "./relations-view";

type Props = {
  state: RelationsUrlState;
  groupCount: number;
  cycleCount: number;
  firstCycleGroup: string | null;
  cyclesComplete: boolean;
};

/** Search, cycles, managers, depth, and display of the relations view. Every control changes the URL. */
export default function RelationsControls(props: Props) {
  const locale = useLocale();
  const t = () => relationsMessages.resolve([locale()]).t;
  const { openPage } = usePageSwap();
  const go = (change: Partial<RelationsUrlState>) => void openPage(relationsHref(props.state, change));
  return (
    <div class="flex flex-wrap items-center gap-2">
      <div class="min-w-[10rem] flex-[1_1_14rem]">
        <Combobox
          aria-label={t().searchLabel}
          placeholder={t().search({ count: props.groupCount })}
          empty={t().searchEmpty}
          fetchData={async (search, signal) => {
            const response = await apiClient.groups.$get({ query: { search, scope: "all", per_page: "10" } }, { init: { signal } });
            const result = await response.json();
            if (!response.ok || !("groups" in result)) throw new Error(t().searchFailed);
            return result.groups.map((group) => ({
              id: group.id,
              label: group.name,
              icon: "ti ti-users-group",
              description: group.provider === "ipa" ? "FreeIPA" : t().local,
            }));
          }}
          onSelect={(option) => go(props.state.view === "list" ? { sel: option.id } : { focus: option.id, sel: undefined, expand: [] })}
        />
      </div>
      <Show
        when={props.cyclesComplete}
        fallback={<FilterToggle icon="ti ti-alert-triangle" label={t().cyclesIncomplete} active={false} disabled />}
      >
        <Show when={props.firstCycleGroup} fallback={<FilterToggle label={t().noCycles} active={false} disabled />}>
          {(first) => (
            <FilterToggle
              icon="ti ti-refresh-alert"
              label={t().cycles({ count: props.cycleCount })}
              active={false}
              href={relationsHref(props.state, { focus: first(), sel: undefined, expand: [] })}
            />
          )}
        </Show>
      </Show>
      <FilterToggle
        icon="ti ti-user-star"
        label={t().managers}
        active={props.state.managers}
        href={relationsHref(props.state, { managers: !props.state.managers })}
      />
      <Show when={props.state.view === "graph"}>
        <div class="flex items-center gap-1.5">
          <span class="text-xs text-dimmed" aria-hidden="true">
            {t().depth}
          </span>
          <SegmentedControl
            ariaLabel={t().depth}
            size="sm"
            options={[1, 2, 3, 4].map((depth) => ({ value: String(depth), label: String(depth) }))}
            value={String(props.state.depth)}
            onValueChange={(depth) => go({ depth: Number(depth), expand: [] })}
          />
        </div>
      </Show>
      {/* A segmented control fills its parent; this box keeps it as wide as its options. */}
      <div class="shrink-0">
        <SegmentedControl
          ariaLabel={t().view}
          size="sm"
          options={[
            { value: "graph", label: t().graph, icon: "ti ti-affiliate" },
            { value: "list", label: t().tree, icon: "ti ti-list-tree" },
          ]}
          value={props.state.view}
          onValueChange={(view) => go({ view: view === "list" ? "list" : "graph" })}
        />
      </div>
    </div>
  );
}
