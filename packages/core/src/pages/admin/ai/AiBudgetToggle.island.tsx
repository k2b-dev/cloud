import { coreClient } from "@k2b/cloud/clients/core";
import { type AiQuotaConfig, AiQuotaConfigSchema } from "@k2b/cloud/shared";
import { Switch, toast, useLocale } from "@k2b/ui";
import { createSignal } from "solid-js";
import { assertAiAdmin, reloadAiArea } from "./client";
import { aiAreaMessages } from "./messages";

type Config = Omit<AiQuotaConfig, "rules"> & { rules: (AiQuotaConfig["rules"][number] & { peopleAtLimit?: number })[] };

/** "Budgets active" in the budgets head: turns every rule on or off at once. */
export default function AiBudgetToggle(props: { config: Config }) {
  const locale = useLocale();
  const t = () => aiAreaMessages.resolve([locale()]).t;
  const [busy, setBusy] = createSignal(false);
  const toggle = async (enabled: boolean) => {
    setBusy(true);
    try {
      const config = AiQuotaConfigSchema.parse({
        ...props.config,
        enabled,
        rules: props.config.rules.map(({ peopleAtLimit: _, ...rule }) => rule),
      });
      await assertAiAdmin(await coreClient.admin.core["ai-quotas"].$put({ json: config }), t().saveFailed);
      reloadAiArea();
    } catch (failure) {
      toast.error(failure instanceof Error ? failure.message : t().saveFailed);
      setBusy(false);
    }
  };
  return <Switch label={t().budgetsOn} value={props.config.enabled} disabled={busy()} onValueChange={(enabled) => void toggle(enabled)} />;
}
