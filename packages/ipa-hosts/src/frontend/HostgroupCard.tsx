import type { IpaHost, IpaHostgroup } from "@/contracts";
import EditHostgroup from "./EditHostgroup.island";
import DeleteHostgroup from "./DeleteHostgroup.island";
import HostsTable from "./HostsTable";
import { hostMessages } from "./messages";
import { useLocale } from "@k2b/ui";

type Props = {
  hostgroup: IpaHostgroup;
  hosts: IpaHost[];
};

const HostgroupCard = (props: Props) => {
  const locale = useLocale();
  const t = () => hostMessages.resolve([locale()]).t;
  const { hostgroup, hosts } = props;

  return (
    <div class="paper overflow-hidden">
      <div class="flex items-center gap-3 bg-[var(--ui-surface-subtle)] px-3 py-3">
        <i class="ti ti-folder text-lg text-blue-500 shrink-0" />
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-2">
            <span class="font-semibold text-sm text-primary truncate">{hostgroup.cn}</span>
            <EditHostgroup cn={hostgroup.cn} description={hostgroup.description} />
          </div>
          {hostgroup.description && <span class="text-xs text-dimmed block truncate">{hostgroup.description}</span>}
        </div>

        {hostgroup.hostgroups.length > 0 && (
          <div class="hidden sm:flex items-center gap-1 flex-wrap shrink-0">
            {hostgroup.hostgroups.map((nestedCn) => (
              <span class="rounded bg-blue-100 px-1.5 py-0.5 text-[10px] font-medium text-blue-700 dark:bg-blue-900/50 dark:text-blue-300">
                {nestedCn}
              </span>
            ))}
          </div>
        )}

        <span class="text-xs text-dimmed shrink-0 whitespace-nowrap">{t().hostCount({ count: hosts.length })}</span>

        <DeleteHostgroup cn={hostgroup.cn} />
      </div>

      <HostsTable hosts={hosts} currentGroup={hostgroup.cn} emptyMessage={t().noHostsInGroup} />
    </div>
  );
};

export default HostgroupCard;
