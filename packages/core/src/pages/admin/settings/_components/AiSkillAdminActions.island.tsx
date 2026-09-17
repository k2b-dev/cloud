import { AuthenticatedPrincipalSchema } from "@k2b/cloud/contracts";
import { PermissionEditor } from "@k2b/cloud/access/ui";
import type { AiSkillAccess } from "@k2b/cloud/ai";
import { coreClient } from "@k2b/cloud/clients/core";
import { refreshCurrentPath } from "@k2b/ssr/nav";
import { mutation as mutations, query } from "@k2b/stdlib/solid";
import { Button, Dropdown, InlineGuidance, NoticeCard, Placeholder, prompts, Select, toast, useLocale } from "@k2b/ui";
import { createSignal, For, Show } from "solid-js";
import { settingsMessages } from "./messages";

type Props = {
  skillId: string;
  skillName: string;
  revision: number;
  templateId: string | null;
};

const readError = async (response: Pick<Response, "json">, fallback: string): Promise<string> => {
  const body = (await response.json().catch(() => null)) as { message?: string } | null;
  return body?.message || fallback;
};

const PermissionDialogBody = (props: Props) => {
  const locale = useLocale();
  const t = () => settingsMessages.resolve([locale()]).t;
  const entries = query.create({
    source: () => props.skillId,
    load: async (skillId, { abortSignal }): Promise<AiSkillAccess[]> => {
      const response = await coreClient.admin.core["ai-skills"][":skillId"].access.$get(
        { param: { skillId } },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await readError(response, t().loadSkillPermissionsFailed));
      return (await response.json()).access;
    },
  });

  const projects = query.create({
    source: () => props.skillId,
    load: async (skillId, { abortSignal }) => {
      const response = await coreClient.admin.core["ai-skills"][":skillId"].projects.$get({param:{skillId}},{init:{signal:abortSignal}});
      if (!response.ok) throw new Error(await readError(response,t().loadSkillPermissionsFailed));
      return (await response.json()).projects;
    },
  });

  return (
    <div class="flex w-full max-w-full flex-col gap-2">
      <p class="text-xs text-dimmed">{t().manageSkillAccess}</p>
      <Show when={projects.loading()}><InlineGuidance loading>{t().loadingSkillAccess}</InlineGuidance></Show>
      <Show when={projects.error()}><InlineGuidance tone="danger">{t().loadSkillAccessFailed}<Button size="sm" variant="ghost" onClick={()=>void projects.refresh()}>{t().retry}</Button></InlineGuidance></Show>
      <Show when={projects.data()?.length}><NoticeCard tone="info" title={t().skillProjectAccessTitle} detail={t().skillProjectAccessHelp}>
        <ul class="flex flex-col gap-1"><For each={projects.data()}>{project=><li class="flex items-center gap-2 text-sm"><i class="ti ti-folders" aria-hidden="true" />{project.name ?? t().skillProjectUnavailable}</li>}</For></ul>
      </NoticeCard></Show>
      <Show when={!entries.loading()} fallback={<Placeholder state="loading" title={t().loadingSkillAccess} />}>
        <Show
          when={entries.data()}
          keyed
          fallback={
            <Placeholder
              state="error"
              title={t().loadSkillAccessFailed}
              description={entries.error()?.message}
              action={
                <Button type="button" variant="secondary" size="sm" onClick={() => void entries.refresh()}>
                  {t().retry}
                </Button>
              }
            />
          }
        >
          {(currentEntries) => (
            <PermissionEditor
              initialEntries={currentEntries}
              canEdit
              allowPublic={false}
              allowServiceAccounts
              grantAccess={async (principal, permission) => {
                const response = await coreClient.admin.core["ai-skills"][":skillId"].access.$post({
                  param: { skillId: props.skillId },
                  json: { principal: AuthenticatedPrincipalSchema.parse(principal), permission },
                });
                if (!response.ok) throw new Error(await readError(response, t().grantSkillAccessFailed));
                return (await response.json()).access;
              }}
              updateAccess={async (accessId, permission) => {
                const response = await coreClient.admin.core["ai-skills"][":skillId"].access[":accessId"].$patch({
                  param: { skillId: props.skillId, accessId },
                  json: { permission },
                });
                if (!response.ok) throw new Error(await readError(response, t().updateSkillAccessFailed));
              }}
              revokeAccess={async (accessId) => {
                const response = await coreClient.admin.core["ai-skills"][":skillId"].access[":accessId"].$delete({
                  param: { skillId: props.skillId, accessId },
                });
                if (!response.ok) throw new Error(await readError(response, t().revokeSkillAccessFailed));
              }}
            />
          )}
        </Show>
      </Show>
    </div>
  );
};

const openPermissionDialog = async (props: Props) => {
  await prompts.dialog<void>(() => <PermissionDialogBody {...props} />, {
    title: props.skillName,
    icon: "ti ti-shield",
  });
  refreshCurrentPath();
};

const TemplateDialogBody = (props: Props & { close: () => void }) => {
  const locale = useLocale();
  const t = () => settingsMessages.resolve([locale()]).t;
  const [selected, setSelected] = createSignal(props.templateId ?? "");
  const templates = query.create({
    source: () => props.skillId,
    load: async (_skillId, { abortSignal }) => {
      const response = await coreClient.admin.core["ai-skills"].templates.$get({}, { init: { signal: abortSignal } });
      if (!response.ok) throw new Error(await readError(response, t().skillTemplateFailed));
      return (await response.json()).templates;
    },
  });
  const apply = mutations.create<void, { mode: "associate" | "reset"; templateId: string; templateVersion: number }>({
    mutation: async (input) => {
      const response = await coreClient.admin.core["ai-skills"][":skillId"].template.$post({
        param: { skillId: props.skillId },
        json: { ...input, expectedRevision: props.revision, confirmed: true },
      });
      if (!response.ok) throw new Error(await readError(response, t().skillTemplateFailed));
    },
    onSuccess: () => {
      toast.success(t().skillTemplateSaved);
      props.close();
      refreshCurrentPath();
    },
    onError: (error) => prompts.error(error.message),
  });
  const submit = async () => {
    const template = templates.data()?.find((item) => item.templateId === selected());
    if (!template || apply.loading()) return;
    const mode = props.templateId ? "reset" : "associate";
    if (
      await prompts.confirm(
        mode === "reset"
          ? t().resetSkillTemplateConfirm({ name: props.skillName, template: template.name, version: template.version })
          : t().associateSkillTemplateConfirm({ name: props.skillName, template: template.name }),
        {
          title: mode === "reset" ? t().resetSkillTemplate : t().associateSkillTemplate,
          confirmText: mode === "reset" ? t().resetSkillTemplate : t().associateSkillTemplate,
          variant: mode === "reset" ? "danger" : "primary",
        },
      )
    )
      await apply.mutate({ mode, templateId: template.templateId, templateVersion: template.version });
  };
  return (
    <div class="space-y-4">
      <p class="text-sm text-dimmed">{props.templateId ? t().resetSkillTemplateHelp : t().associateSkillTemplateHelp}</p>
      <Show when={templates.error()}>
        <Placeholder
          title={t().skillTemplateFailed}
          icon="ti ti-alert-circle"
          action={<Button onClick={() => void templates.refresh()}>{t().retry}</Button>}
        />
      </Show>
      <Show
        when={templates.data()}
        fallback={
          <Show when={!templates.error()}>
            <InlineGuidance loading>{t().loadingSkillTemplates}</InlineGuidance>
          </Show>
        }
      >
        {(items) => (
          <>
            <Select
              value={selected}
              onValueChange={(value) => setSelected(value ?? "")}
              disabled={!!props.templateId || apply.loading()}
              aria-label={t().skillTemplate}
              placeholder={t().chooseSkillTemplate}
              options={items().map((item) => ({ value: item.templateId, label: `${item.name} · v${item.version}` }))}
            />
            <Button disabled={!items().some((item) => item.templateId === selected()) || apply.loading()} onClick={() => void submit()}>
              {props.templateId ? t().resetSkillTemplate : t().associateSkillTemplate}
            </Button>
          </>
        )}
      </Show>
    </div>
  );
};

export default function AiSkillAdminActions(props: Props) {
  const locale = useLocale();
  const t = () => settingsMessages.resolve([locale()]).t;
  const remove = mutations.create<void, void>({
    mutation: async () => {
      const response = await coreClient.admin.core["ai-skills"][":skillId"].$delete({ param: { skillId: props.skillId } });
      if (!response.ok) throw new Error(await readError(response, t().deleteSkillFailed));
    },
    onSuccess: () => {
      toast.success(t().skillDeleted);
      refreshCurrentPath();
    },
    onError: (error) => prompts.error(error instanceof Error ? error.message : t().deleteSkillFailed),
  });

  const handleDelete = async () => {
    const confirmed = await prompts.confirm(t().deleteSkillConfirm({ name: props.skillName }), {
      title: t().deleteSkill,
      icon: "ti ti-trash",
      variant: "danger",
      confirmText: t().delete,
    });
    if (confirmed) remove.mutate();
  };

  return (
    <Dropdown.Root
      position="bottom-left"
      width="13rem"
      items={[
        {
          items: [
            {
              icon: "ti ti-refresh",
              label: props.templateId ? t().resetSkillTemplate : t().associateSkillTemplate,
              action: () =>
                void prompts.dialog<void>((close) => <TemplateDialogBody {...props} close={close} />, {
                  title: props.skillName,
                  icon: "ti ti-wand",
                }),
            },
            {
              icon: "ti ti-shield",
              label: t().permissions,
              action: () => void openPermissionDialog(props),
            },
            {
              icon: "ti ti-trash",
              label: t().deleteSkill,
              variant: "danger",
              action: () => void handleDelete(),
            },
          ],
        },
      ]}
    >
      <Dropdown.Trigger iconOnly label={t().actionsFor({ name: props.skillName })} size="xs" tooltip={t().skillActions}>
        <i class="ti ti-settings text-sm" />
      </Dropdown.Trigger>
    </Dropdown.Root>
  );
}
