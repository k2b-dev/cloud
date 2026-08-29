import { navigateTo } from "@k2b/ssr/nav";
import { FilterChip, type FilterChipSection, useLocale } from "@k2b/ui";
import { gatewayOpsMessages } from "../../../messages";

type Props = {
  apps: string[];
  app: string;
  state: string;
  mode: string;
  showRunFilters?: boolean;
  /** Pre-built by the page, so the island never has to know the other params. */
  hrefFor: Record<"app" | "state" | "mode", Record<string, string>>;
};

export default function WorkflowsFilterBar(props: Props) {
  const { t } = gatewayOpsMessages.resolve([useLocale()()]);
  const stateOptions: FilterChipSection[] = [{ options: [
    { value: "all", label: t.allStates, icon: "ti ti-list" },
    { value: "failed", label: t.failed, icon: "ti ti-alert-triangle" },
    { value: "needs_attention", label: t.needsAttentionLabel, icon: "ti ti-hand-stop" },
    { value: "waiting", label: t.waiting, icon: "ti ti-clock-pause" },
    { value: "running", label: t.running, icon: "ti ti-player-play" },
    { value: "queued", label: t.queued, icon: "ti ti-hourglass" },
    { value: "succeeded", label: t.succeeded, icon: "ti ti-check" },
    { value: "canceled", label: t.canceled, icon: "ti ti-ban" },
  ] }];
  const modeOptions: FilterChipSection[] = [{ options: [
    { value: "all", label: t.anyMode, icon: "ti ti-arrows-shuffle" },
    { value: "execute", label: t.execute, icon: "ti ti-bolt" },
    { value: "dryRun", label: t.dryRun, icon: "ti ti-eye" },
  ] }];
  const appOptions = (): FilterChipSection[] => [
    {
      options: [
        { value: "", label: t.allApps, icon: "ti ti-apps" },
        ...props.apps.map((app) => ({ value: app, label: app, icon: "ti ti-app-window" })),
      ],
    },
  ];

  return (
    <div class="flex flex-wrap items-center gap-2">
      <FilterChip
        label={t.app}
        icon="ti ti-apps"
        options={appOptions()}
        value={props.app ? [props.app] : [""]}
        onValueChange={(value) => navigateTo(props.hrefFor.app[value[0] ?? ""] ?? props.hrefFor.app[""] ?? "")}
        isActive={Boolean(props.app)}
        defaultValue={[""]}
      />
      {props.showRunFilters !== false ? (
        <>
          <FilterChip
            label={t.state}
            icon="ti ti-activity"
            options={stateOptions}
            value={[props.state]}
            onValueChange={(value) => navigateTo(props.hrefFor.state[value[0] ?? "all"] ?? "")}
            isActive={props.state !== "all"}
            defaultValue={["all"]}
          />
          <FilterChip
            label={t.mode}
            icon="ti ti-arrows-shuffle"
            options={modeOptions}
            value={[props.mode]}
            onValueChange={(value) => navigateTo(props.hrefFor.mode[value[0] ?? "all"] ?? "")}
            isActive={props.mode !== "all"}
            defaultValue={["all"]}
          />
        </>
      ) : null}
    </div>
  );
}
