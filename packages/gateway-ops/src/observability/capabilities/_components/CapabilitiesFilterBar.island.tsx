import { navigateTo } from "@k2b/ssr/nav";
import { FilterChip, type FilterChipSection, useLocale } from "@k2b/ui";
import { capabilityOpsMessages } from "../ops-messages";

type Props = {
  apps: string[];
  capabilities: string[];
  app: string;
  capability: string;
  origin: string;
  status: string;
  window: string;
  destructive: boolean;
  /** Pre-built by the page, so the island never has to know the other params. */
  hrefFor: Record<"app" | "capability" | "origin" | "status" | "window" | "destructive", Record<string, string>>;
};

export default function CapabilitiesFilterBar(props: Props) {
  const { t } = capabilityOpsMessages.resolve([useLocale()()]);
  const section = (options: FilterChipSection["options"]): FilterChipSection[] => [{ options }];
  const originOptions = () =>
    section([
      { value: "all", label: t.allOrigins, icon: "ti ti-list" },
      { value: "assistant", label: t.originAssistant, icon: "ti ti-sparkles" },
      { value: "mcp", label: t.originMcp, icon: "ti ti-plug-connected" },
      { value: "http", label: t.originHttp, icon: "ti ti-world" },
      { value: "app", label: t.originApp, icon: "ti ti-app-window" },
    ]);
  const statusOptions = () =>
    section([
      { value: "all", label: t.allStatuses, icon: "ti ti-list" },
      { value: "failed", label: t.statusFailed, icon: "ti ti-alert-triangle" },
      { value: "timed_out", label: t.statusTimedOut, icon: "ti ti-clock-exclamation" },
      { value: "invalid_input", label: t.statusInvalidInput, icon: "ti ti-forms" },
      { value: "denied", label: t.statusDenied, icon: "ti ti-lock" },
      { value: "rejected", label: t.statusRejected, icon: "ti ti-hand-stop" },
      { value: "succeeded", label: t.statusSucceeded, icon: "ti ti-check" },
    ]);
  const windowOptions = () => section(["1h", "24h", "7d", "30d", "90d"].map((value) => ({ value, label: value, icon: "ti ti-clock" })));
  const listOptions = (values: string[], allLabel: string, icon: string) =>
    section([{ value: "", label: allLabel, icon: "ti ti-list" }, ...values.map((value) => ({ value, label: value, icon }))]);
  const go = (map: Record<string, string>, value: string | undefined, fallback: string) =>
    navigateTo(map[value ?? fallback] ?? map[fallback] ?? "");

  return (
    <div class="flex flex-wrap items-center gap-2">
      <FilterChip
        label={t.app}
        icon="ti ti-apps"
        options={listOptions(props.apps, t.allApps, "ti ti-app-window")}
        value={props.app ? [props.app] : [""]}
        onValueChange={(value) => go(props.hrefFor.app, value[0], "")}
        isActive={Boolean(props.app)}
        defaultValue={[""]}
      />
      <FilterChip
        label={t.capability}
        icon="ti ti-plug"
        options={listOptions(props.capabilities, t.allCapabilities, "ti ti-bolt")}
        value={props.capability ? [props.capability] : [""]}
        onValueChange={(value) => go(props.hrefFor.capability, value[0], "")}
        isActive={Boolean(props.capability)}
        defaultValue={[""]}
      />
      <FilterChip
        label={t.origin}
        icon="ti ti-arrow-guide"
        options={originOptions()}
        value={[props.origin]}
        onValueChange={(value) => go(props.hrefFor.origin, value[0], "all")}
        isActive={props.origin !== "all"}
        defaultValue={["all"]}
      />
      <FilterChip
        label={t.status}
        icon="ti ti-activity"
        options={statusOptions()}
        value={[props.status]}
        onValueChange={(value) => go(props.hrefFor.status, value[0], "all")}
        isActive={props.status !== "all"}
        defaultValue={["all"]}
      />
      <FilterChip
        label={t.destructiveOnly}
        icon="ti ti-flame"
        options={section([
          { value: "off", label: t.allStatuses, icon: "ti ti-list" },
          { value: "on", label: t.destructiveOnly, icon: "ti ti-flame" },
        ])}
        value={[props.destructive ? "on" : "off"]}
        onValueChange={(value) => go(props.hrefFor.destructive, value[0], "off")}
        isActive={props.destructive}
        defaultValue={["off"]}
      />
      <FilterChip
        label={t.window}
        icon="ti ti-clock"
        options={windowOptions()}
        value={[props.window]}
        onValueChange={(value) => go(props.hrefFor.window, value[0], "24h")}
        isActive={props.window !== "24h"}
        defaultValue={["24h"]}
      />
    </div>
  );
}
