import { refreshCurrentPath } from "@k2b/ssr/nav";
import { mutation } from "@k2b/stdlib/solid";
import { Button, Checkbox, CopyButton, NoticeCard, prompts, TextInput } from "@k2b/ui";
import { createSignal, Show } from "solid-js";
import { apiClient } from "@/api/client";
import { type BaseGroup, BaseGroupSchema, ErrorResponseSchema } from "@/contracts";
import { type accountsMessages, useAccountsMessages } from "../messages";

type ProviderChoice = "ipa" | "local";

const normalizeName = (v: string): string =>
  v
    .toLowerCase()
    .replace(/[_ ]/g, "-")
    .replace(/[^a-z0-9-]/g, "");

type AccountsCopy = ReturnType<typeof accountsMessages.resolve>["t"];

const providerCards = (
  t: AccountsCopy,
): Array<{
  value: ProviderChoice;
  title: string;
  eyebrow: string;
  description: string;
  icon: string;
}> => [
  {
    value: "ipa",
    title: t.freeIpaGroup,
    eyebrow: t.directory,
    description: t.freeIpaGroupDescription,
    icon: "ti ti-building-fortress",
  },
  {
    value: "local",
    title: t.localGroup,
    eyebrow: t.appManaged,
    description: t.localGroupDescription,
    icon: "ti ti-home-spark",
  },
];

const PROVIDER_CARD_CLASS =
  "group flex min-h-36 flex-col items-start gap-3 rounded-xl bg-zinc-50/85 px-4 py-4 text-left transition hover:bg-blue-50/45 dark:bg-zinc-900/70 dark:hover:bg-blue-950/20";
const PROVIDER_CARD_ICON_CLASS =
  "flex h-10 w-10 items-center justify-center rounded-lg bg-white text-zinc-600 shadow-sm shadow-zinc-950/[0.04] transition group-hover:text-blue-600 dark:bg-zinc-950/75 dark:text-zinc-300 dark:shadow-none dark:group-hover:text-blue-300";

type CreateGroupPayload = {
  provider: ProviderChoice;
  name: string;
  description?: string;
  posix?: boolean;
};

type CreateGroupResult = {
  group: BaseGroup;
  command?: string;
};

function ProviderSelectionDialog(props: { close: (provider?: ProviderChoice) => void }) {
  const messages = useAccountsMessages();
  return (
    <div class="flex flex-col gap-3">
      <div class="flex flex-col gap-1">
        <p class="text-sm font-medium text-primary">{messages().chooseGroupProviderQuestion}</p>
        <p class="text-xs text-dimmed">{messages().chooseGroupProviderDescription}</p>
      </div>

      <div class="grid gap-3 md:grid-cols-2">
        {providerCards(messages()).map((provider) => (
          <button type="button" class={PROVIDER_CARD_CLASS} onClick={() => props.close(provider.value)}>
            <div class="flex items-center gap-3">
              <div class={PROVIDER_CARD_ICON_CLASS}>
                <i class={`${provider.icon} text-lg`} />
              </div>
              <div class="flex flex-col gap-0.5">
                <span class="text-[11px] font-semibold uppercase tracking-[0.18em] text-dimmed">{provider.eyebrow}</span>
                <span class="text-sm font-semibold text-primary">{provider.title}</span>
              </div>
            </div>
            <p class="text-sm leading-6 text-secondary">{provider.description}</p>
          </button>
        ))}
      </div>
    </div>
  );
}

function CreateGroupDialog(props: { provider: ProviderChoice; close: (payload?: CreateGroupPayload) => void }) {
  const messages = useAccountsMessages();
  const [name, setName] = createSignal("");
  const [description, setDescription] = createSignal("");
  const [posix, setPosix] = createSignal(props.provider === "ipa");
  const [error, setError] = createSignal<string | undefined>(undefined);

  const handleSubmit = () => {
    const normalized = normalizeName(name());
    if (!normalized) {
      setError(messages().groupNameInvalid);
      return;
    }

    props.close({
      provider: props.provider,
      name: normalized,
      description: description().trim() || undefined,
      posix: props.provider === "ipa" ? posix() : undefined,
    });
  };

  return (
    <div class="flex flex-col gap-5">
      <div class="flex flex-col gap-1">
        <p class="text-sm font-medium text-primary">
          {props.provider === "ipa" ? messages().createFreeIpaGroup : messages().createLocalGroup}
        </p>
        <p class="text-xs text-dimmed">
          {props.provider === "ipa" ? messages().freeIpaGroupCreationDescription : messages().localGroupCreationDescription}
        </p>
      </div>

      <Show when={props.provider === "ipa"}>
        <NoticeCard tone="info" icon={false}>
          <div class="flex items-start gap-3">
            <i class="ti ti-info-circle mt-0.5 text-base" />
            <div class="flex flex-col gap-1">
              <span class="font-medium">{messages().directoryGroupsAuthoritative}</span>
              <span class="text-xs text-blue-700/90 dark:text-blue-200/80">{messages().posixOnlyWhenNeeded}</span>
            </div>
          </div>
        </NoticeCard>
      </Show>

      <div class="grid gap-4">
        <TextInput
          label={messages().name}
          required
          icon="ti ti-hash"
          value={name}
          onValueChange={(value) => {
            setName(value);
            if (error()) setError(undefined);
          }}
          error={error}
          placeholder="my-group"
          description={messages().normalizedGroupName}
        />
        <TextInput
          label={messages().description}
          icon="ti ti-notes"
          value={description}
          onValueChange={setDescription}
          placeholder={messages().groupPurposePlaceholder}
          multiline
        />
      </div>

      <Show when={props.provider === "ipa"}>
        <Checkbox
          label={messages().createPosixGroup}
          description={messages().posixGroupDescription}
          value={posix}
          onValueChange={setPosix}
        />
      </Show>

      <div class="flex justify-end">
        <Button size="sm" onClick={handleSubmit}>
          {messages().continue}
        </Button>
      </div>
    </div>
  );
}

export default function NewGroup(props: { freeIpaEnabled?: boolean }) {
  const messages = useAccountsMessages();
  const freeIpaEnabled = props.freeIpaEnabled ?? true;

  const createMutation = mutation.create<CreateGroupResult | undefined, void>({
    mutation: async () => {
      const provider = freeIpaEnabled
        ? await prompts.dialog<ProviderChoice>((close) => <ProviderSelectionDialog close={close} />, {
            title: messages().chooseGroupProvider,
            icon: "ti ti-users-group",
            size: "medium",
          })
        : "local";
      if (!provider) return undefined;

      const payload = await prompts.dialog<CreateGroupPayload>((close) => <CreateGroupDialog provider={provider} close={close} />, {
        title: provider === "ipa" ? messages().createFreeIpaGroup : messages().createLocalGroup,
        icon: provider === "ipa" ? "ti ti-building-fortress" : "ti ti-home-spark",
        size: "large",
      });
      if (!payload) return undefined;

      const confirmed = await prompts.confirm(
        <div class="flex flex-col gap-4 text-sm">
          <p>{messages().confirmNewGroup}</p>
          <dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2">
            <dt class="text-dimmed">{messages().managedBy}</dt>
            <dd>{payload.provider === "ipa" ? "FreeIPA" : messages().local}</dd>
            <dt class="text-dimmed">{messages().name}</dt>
            <dd class="font-mono">{payload.name}</dd>
            <Show when={payload.description}>
              <dt class="text-dimmed">{messages().description}</dt>
              <dd>{payload.description}</dd>
            </Show>
            <Show when={payload.provider === "ipa"}>
              <dt class="text-dimmed">POSIX</dt>
              <dd>{payload.posix ? messages().yes : messages().no}</dd>
            </Show>
          </dl>
        </div>,
        {
          title: messages().confirmGroupCreation,
          icon: "ti ti-users-group",
          confirmText: messages().createGroup,
          size: "large",
        },
      );
      if (!confirmed) return undefined;

      const res = await apiClient.groups.$post({ json: payload });
      if (!res.ok) {
        const data = ErrorResponseSchema.safeParse(await res.json());
        throw new Error(data.success ? data.data.message : messages().createGroupFailed);
      }

      const data = BaseGroupSchema.parse(await res.json());
      return {
        group: data,
        command: data.gidnumber ? `sudo nfsctl groupadd ${data.name}` : undefined,
      };
    },
    onSuccess: async (result) => {
      if (!result) return;

      if (!result.command) {
        await prompts.success(messages().groupCreatedMessage({ name: result.group.name }), {
          title: messages().groupCreated,
          icon: "ti ti-check",
        });
        refreshCurrentPath();
        return;
      }

      const command = result.command;
      await prompts.dialog<void>(
        (close) => (
          <div class="flex flex-col gap-4">
            <NoticeCard tone="success" icon={false}>
              {messages().freeIpaGroupCreatedMessage({ name: result.group.name })}
            </NoticeCard>
            <NoticeCard tone="info" icon={false} bodyClass="flex flex-col gap-3">
              <div class="flex items-center justify-between gap-3">
                <div class="flex flex-col">
                  <span class="text-sm font-medium text-primary">{messages().nfsFollowUp}</span>
                  <span class="text-xs text-dimmed">{messages().runOnNfsServer}</span>
                </div>
                <CopyButton text={command} label={messages().copy} />
              </div>
              <pre class="overflow-x-auto whitespace-pre rounded-xl bg-white/80 px-3 py-3 text-xs font-mono text-secondary dark:bg-zinc-950/80">
                {command}
              </pre>
            </NoticeCard>
            <div class="flex justify-end">
              <Button
                size="sm"
                onClick={() => {
                  close();
                  refreshCurrentPath();
                }}
              >
                {messages().done}
              </Button>
            </div>
          </div>
        ),
        { title: messages().groupCreated, icon: "ti ti-check", size: "large" },
      );
    },
    onError: (error) => prompts.error(error instanceof Error ? error.message : messages().createGroupFailed),
  });

  return (
    <Button
      size="sm"
      variant="subtle"
      class="shrink-0 self-stretch px-3"
      onClick={() => void createMutation.mutate(undefined)}
      disabled={createMutation.loading()}
    >
      <i class={createMutation.loading() ? "ti ti-loader-2 animate-spin" : "ti ti-plus"} />
      <span class="hidden sm:inline">{createMutation.loading() ? messages().creating : messages().newGroup}</span>
    </Button>
  );
}
