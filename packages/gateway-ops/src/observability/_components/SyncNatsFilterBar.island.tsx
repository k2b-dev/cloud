import { navigateTo } from "@k2b/ssr/nav";
import { FilterChip, useLocale } from "@k2b/ui";
import { SearchBar } from "@valentinkolb/cloud/ssr/islands";
import { gatewayOpsMessages } from "../../messages";
import { natsMessages } from "../nats/messages";
import { syncOpsMessages } from "../sync/ops-messages";
import { type SyncNatsPath, syncNatsFilterHref } from "./sync-nats-filters";

type Props = { path: SyncNatsPath; search: string; apps: string[]; namespaces?: string[] };
export default function SyncNatsFilterBar(props: Props) {
  const locale = useLocale()();
  const { t } = gatewayOpsMessages.resolve([locale]);
  const { t: n } = natsMessages.resolve([locale]);
  const { t: s } = syncOpsMessages.resolve([locale]);
  const params = () => new URLSearchParams(props.search);
  const app = () => params().get("app") ?? "";
  const namespace = () => params().get("namespace") ?? "";
  const resource = () => params().get("resource") ?? "";
  const problems = () => ["true", "on"].includes(params().get("problems") ?? "");
  const navigate = (updates: Record<string, string | null>) => navigateTo(syncNatsFilterHref(props.path, props.search, updates));
  const options = (values: string[], selected: string, all: string, icon: string) => [
    {
      options: [
        { value: "", label: all, icon: "ti ti-list" },
        ...[...new Set([...values, ...(selected ? [selected] : [])])].sort().map((value) => ({ value, label: value, icon })),
      ],
    },
  ];
  const searchLabel = () => (props.path.endsWith("nats") ? n.resourceFilter : s.resource);
  return (
    <div class="flex flex-col gap-2">
      <SearchBar
        action={syncNatsFilterHref(props.path, props.search)}
        value={resource()}
        param="resource"
        placeholder={searchLabel()}
        ariaLabel={searchLabel()}
      />
      <div class="flex flex-wrap items-center gap-2">
        <FilterChip
          label={t.app}
          icon="ti ti-apps"
          options={options(props.apps, app(), t.allApps, "ti ti-app-window")}
          value={[app()]}
          defaultValue={[""]}
          isActive={Boolean(app())}
          onValueChange={(value) => navigate({ app: value[0] ?? "" })}
        />
        {props.namespaces ? (
          <FilterChip
            label={n.namespaceFilter}
            icon="ti ti-folders"
            options={options(props.namespaces, namespace(), t.all, "ti ti-folder")}
            value={[namespace()]}
            defaultValue={[""]}
            isActive={Boolean(namespace())}
            onValueChange={(value) => navigate({ namespace: value[0] ?? "" })}
          />
        ) : null}
        <FilterChip
          label={t.state}
          icon="ti ti-activity"
          options={[
            {
              options: [
                { value: "", label: t.allStates, icon: "ti ti-list" },
                { value: "true", label: s.problems, icon: "ti ti-alert-triangle" },
              ],
            },
          ]}
          value={[problems() ? "true" : ""]}
          defaultValue={[""]}
          isActive={problems()}
          onValueChange={(value) => navigate({ problems: value[0] ?? "" })}
        />
        {app() || namespace() || resource() || problems() ? (
          <a href={props.path} class="text-[10px] text-red-500 tabular-nums" aria-label={t.clearAllFilters}>
            <i class="ti ti-x" aria-hidden="true" /> {t.clear}
          </a>
        ) : null}
      </div>
    </div>
  );
}
