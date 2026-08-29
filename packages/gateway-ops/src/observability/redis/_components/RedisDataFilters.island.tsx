import { navigateTo } from "@k2b/ssr/nav";
import { FilterChip, type FilterChipSection, useLocale } from "@k2b/ui";
import { gatewayOpsMessages } from "../../../messages";

type Props = {
  search: string;
  depth: number;
};

const buildUrl = (input: { search: string; depth: number }) => {
  const params = new URLSearchParams();
  if (input.search.trim()) params.set("search", input.search.trim());
  if (input.depth !== 3) params.set("depth", String(input.depth));
  const query = params.toString();
  return query ? `/admin/observability/redis?${query}` : "/admin/observability/redis";
};

export default function RedisDataFilters(props: Props) {
  const { t } = gatewayOpsMessages.resolve([useLocale()()]);
  const depthOptions: FilterChipSection[] = [{ options: [
    { value: "1", label: t.depthOption({ depth: 1 }), icon: "ti ti-hierarchy" },
    { value: "2", label: t.depthOption({ depth: 2 }), icon: "ti ti-hierarchy-2" },
    { value: "3", label: t.depthOption({ depth: 3 }), icon: "ti ti-hierarchy-3" },
  ] }];
  return (
    <div class="flex flex-wrap items-center gap-2">
      <FilterChip
        label={t.prefixDepth}
        icon="ti ti-hierarchy"
        options={depthOptions}
        value={[String(props.depth)]}
        onValueChange={(value) => navigateTo(buildUrl({ search: props.search, depth: Number(value[0] ?? "3") }))}
        isActive={props.depth !== 3}
        defaultValue={["3"]}
      />
    </div>
  );
}
