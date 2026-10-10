import { coreClient } from "@k2b/cloud/clients/core";
import { refreshCurrentPath } from "@k2b/ssr/nav";
import { mutation as mutations } from "@k2b/stdlib/solid";
import { Dropdown, prompts, toast, useLocale } from "@k2b/ui";
import { settingsMessages } from "./messages";

type Props = {
  appId: string;
  appName: string;
  name: string;
  state: "deleted" | "name_taken";
};

type Action = "restore" | "adopt";

/** Installs a deleted or blocked app Skill again, or links the Skill that already uses its name. */
export default function AiAppSkillIssueActions(props: Props) {
  const locale = useLocale();
  const t = () => settingsMessages.resolve([locale()]).t;
  const run = mutations.create<Action, Action>({
    mutation: async (action) => {
      const route = coreClient.admin.core["ai-skills"].apps[":appId"].skills[":name"];
      const request = { param: { appId: props.appId, name: props.name }, json: { confirmed: true as const } };
      const response = action === "adopt" ? await route.adopt.$post(request) : await route.restore.$post(request);
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { message?: string } | null;
        throw new Error(body?.message || t().appSkillActionFailed);
      }
      return action;
    },
    onSuccess: (action) => {
      toast.success(action === "adopt" ? t().appSkillAdopted : t().appSkillInstalled);
      refreshCurrentPath();
    },
    onError: (error) => prompts.error(error instanceof Error ? error.message : t().appSkillActionFailed),
  });

  const confirm = async (action: Action) => {
    const label = action === "adopt" ? t().adoptAppSkill : props.state === "deleted" ? t().restoreAppSkill : t().installAppSkill;
    const confirmed = await prompts.confirm(
      action === "adopt"
        ? t().adoptAppSkillConfirm({ name: props.name, app: props.appName })
        : t().restoreAppSkillConfirm({ name: props.name, app: props.appName }),
      { title: label, icon: action === "adopt" ? "ti ti-link" : "ti ti-restore", confirmText: label },
    );
    if (confirmed) run.mutate(action);
  };

  return (
    <Dropdown.Root
      position="bottom-left"
      width="14rem"
      disabled={run.loading()}
      items={[
        {
          items: [
            {
              icon: "ti ti-restore",
              label: props.state === "deleted" ? t().restoreAppSkill : t().installAppSkill,
              action: () => void confirm("restore"),
            },
            ...(props.state === "name_taken"
              ? [{ icon: "ti ti-link", label: t().adoptAppSkill, action: () => void confirm("adopt") }]
              : []),
          ],
        },
      ]}
    >
      <Dropdown.Trigger iconOnly label={t().appSkillActions({ name: props.name })} size="xs" tooltip={t().skillActions}>
        <i class={run.loading() ? "ti ti-loader-2 k2b-spin text-sm" : "ti ti-settings text-sm"} aria-hidden="true" />
      </Dropdown.Trigger>
    </Dropdown.Root>
  );
}
