import { SearchBar } from "@k2b/cloud/ssr/islands";
import { navigateTo } from "@k2b/ssr/nav";
import { ButtonLink, FilterChip, type FilterChipSection, useLocale } from "@k2b/ui";
import { gatewayOpsMessages } from "../../../messages";
import { buildRedisFilterUrl, defaultRedisFilter, hasActiveRedisFilters, parseRedisDepth, type RedisFilter } from "./filter-state";

export default function RedisDataFilters(props: RedisFilter) {
  const { t } = gatewayOpsMessages.resolve([useLocale()()]);
  const depthOptions: FilterChipSection[] = [
    {
      options: [
        { value: "1", label: t.depthOption({ depth: 1 }), icon: "ti ti-hierarchy" },
        { value: "2", label: t.depthOption({ depth: 2 }), icon: "ti ti-hierarchy-2" },
        { value: "3", label: t.depthOption({ depth: 3 }), icon: "ti ti-hierarchy-3" },
      ],
    },
  ];
  return (
    <div class="flex flex-col gap-2">
      <SearchBar
        action={buildRedisFilterUrl(props, { search: "" })}
        value={props.search}
        placeholder={t.searchRedisPrefixes}
        ariaLabel={t.searchRedisPrefixesLabel}
      />
      <div class="flex flex-wrap items-center gap-2">
        <FilterChip
          label={t.prefixDepth}
          icon="ti ti-hierarchy"
          options={depthOptions}
          value={[String(props.depth)]}
          onValueChange={(value) => navigateTo(buildRedisFilterUrl(props, { depth: parseRedisDepth(value[0]) }))}
          isActive={props.depth !== 3}
          defaultValue={["3"]}
        />
        {hasActiveRedisFilters(props) && (
          <ButtonLink href={buildRedisFilterUrl(defaultRedisFilter)} variant="ghost" size="sm" aria-label={t.clearAllFilters}>
            <i class="ti ti-x" aria-hidden="true" /> {t.clear}
          </ButtonLink>
        )}
      </div>
    </div>
  );
}
