import { Button, Combobox, IconButton, InlineGuidance, LocaleProvider, prompts, Select, TextInput } from "@k2b/ui";
import { createEffect, createResource, createSignal, For, type JSX, on, onCleanup, Show } from "solid-js";
import { z } from "zod";
import { chatMessages } from "../messages";
import { type DiscoveryEntrySchema, MEMBER_PAGE_SIZE } from "../service/contracts";
import { type ChannelApi, createChannelApi } from "./channel-api";
import { type ChatDialogStore, type Conversation, DialogActions, DialogError, errorMessage, useChatMessages } from "./chat-dialog";
import { createIntent } from "./create-intent";

type Entry = z.infer<typeof DiscoveryEntrySchema> & { displayName: string };
type EditProps = {
  store: ChatDialogStore;
  viewerId: string;
  locale: string;
  guest: boolean;
  conversation?: Conversation;
  onSaved?: () => Promise<void>;
  onBusyChange?: (busy: boolean) => void;
};
export const openChannelDialog = (props: EditProps) =>
  prompts.dialog<string>(
    (close, context) => (
      <LocaleProvider locale={props.locale}>
        <ChannelDialog {...props} close={close} setDismissHandler={context.setDismissHandler} />
      </LocaleProvider>
    ),
    {
      title: props.conversation
        ? chatMessages.resolve([props.locale]).t.discoverySettings
        : chatMessages.resolve([props.locale]).t.newChannel,
      icon: "ti ti-hash",
      size: "medium",
    },
  );

export function ChannelDialog(
  props: EditProps & { close: (id?: string) => void; setDismissHandler: (handler: () => void) => void; api?: ChannelApi },
): JSX.Element {
  const api = props.api ?? createChannelApi();
  const t = useChatMessages();
  const [name, setName] = createSignal(props.conversation?.name ?? "");
  const [purpose, setPurpose] = createSignal(props.conversation?.purpose ?? "");
  const [entries, setEntries] = createSignal<Entry[]>([]);
  const [permission, setPermission] = createSignal<"read" | "write">("write");
  const [busy, setBusy] = createSignal(false);
  createEffect(() => props.onBusyChange?.(busy()));
  const [error, setError] = createSignal("");
  const [previewError, setPreviewError] = createSignal(false);
  const [count, setCount] = createSignal<number>();
  const [countLoading, setCountLoading] = createSignal(false);
  const [recovering, setRecovering] = createSignal(false);
  const intent = props.conversation
    ? undefined
    : createIntent(`${props.viewerId}:channel`, (saved) => {
        setRecovering(true);
        setName(saved.input.name ?? "");
        setPurpose(saved.input.purpose ?? "");
        setEntries(
          (saved.input.discovery ?? []).map((entry) => ({
            ...entry,
            displayName:
              entry.principal.type === "authenticated"
                ? t().allAuthenticated
                : (saved.chosen.find(
                    (chosen) =>
                      chosen.principal.type === "group" &&
                      entry.principal.type === "group" &&
                      chosen.principal.groupId === entry.principal.groupId,
                  )?.displayName ?? t().unavailable),
          })),
        );
      });
  const locked = () => busy() || !!intent?.pending();
  const cancel = () => {
    intent?.clear();
    props.close();
  };
  let previewGeneration = 0;
  const [options, { refetch }] = createResource(async () => {
    if (!props.conversation) return api.options();
    const settings = await api.get(props.conversation.id);
    setEntries(settings.entries);
    return settings;
  });
  props.setDismissHandler(() => {
    if (!busy()) props.close();
  });
  const preview = async () => {
    const mine = ++previewGeneration;
    setCountLoading(true);
    setPreviewError(false);
    if (
      intent?.pending() ||
      options.loading ||
      options.error ||
      (!options()?.allowAuthenticated && entries().some((entry) => entry.principal.type === "authenticated"))
    ) {
      setCountLoading(false);
      return;
    }
    try {
      const result = await api.preview(
        entries().map(({ principal, permission }) => ({ principal, permission })),
        props.conversation?.id,
      );
      if (mine === previewGeneration) setCount(result.audienceCount);
    } catch {
      if (mine === previewGeneration) setPreviewError(true);
    } finally {
      if (mine === previewGeneration) setCountLoading(false);
    }
  };
  createEffect(
    on(
      () => [entries(), options.loading, options.error ? undefined : options()?.allowAuthenticated],
      () => {
        previewGeneration++;
        setCount(undefined);
        const timer = setTimeout(() => void preview(), 250);
        onCleanup(() => clearTimeout(timer));
      },
    ),
  );
  onCleanup(() => {
    previewGeneration++;
  });
  const save = async () => {
    if (busy()) return;
    if (!intent?.pending()) {
      if (options.loading || options.error || previewError() || countLoading() || count() === undefined) return;
      if (entries().length && !name().trim()) {
        setError(t().channelNameRequired);
        return;
      }
      if ((entries().length || !props.conversation) && !purpose().trim()) {
        setError(t().channelPurposeRequired);
        return;
      }
    }
    setBusy(true);
    setError("");
    try {
      const discovery = entries().map(({ principal, permission }) => ({ principal, permission }));
      if (props.conversation) {
        await api.update(props.conversation.id, { name: name().trim(), purpose: purpose().trim(), entries: discovery });
        await props.onSaved?.();
        props.close(props.conversation.id);
      } else if (intent) {
        const input = intent.begin(
          { members: [], name: name().trim(), purpose: purpose().trim(), discovery },
          entries().flatMap((entry) =>
            entry.principal.type === "group" ? [{ principal: entry.principal, displayName: entry.displayName }] : [],
          ),
        );
        const result = await props.store.create(input);
        if (result.outcome !== "created") throw new Error(t().requestFailed);
        intent.clear();
        props.close(result.conversation.id);
      }
    } catch (failure) {
      intent?.failed(failure);
      setRecovering(!!intent?.pending());
      setError(errorMessage(failure, t().requestFailed));
    } finally {
      setBusy(false);
    }
  };
  const choose = (principal: Entry["principal"], displayName: string) => {
    if (locked() || entries().length >= MEMBER_PAGE_SIZE) return;
    const key = principal.type === "group" ? principal.groupId : "authenticated";
    if (entries().some((entry) => (entry.principal.type === "group" ? entry.principal.groupId : "authenticated") === key)) return;
    setEntries([...entries(), { principal, displayName, permission: permission() }]);
  };
  return (
    <div class="chat-dialog">
      <form
        id="chat-channel"
        class="chat-dialog__body"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <TextInput label={t().name} required value={name} onValueChange={setName} maxLength={80} disabled={locked()} />
        <TextInput
          label={t().purpose}
          required={!props.conversation || entries().length > 0}
          value={purpose}
          onValueChange={setPurpose}
          maxLength={300}
          disabled={locked()}
        />
        <InlineGuidance icon="ti ti-history">{t().discoveryHistory}</InlineGuidance>
        <Show when={!intent?.pending() && options.loading}>
          <InlineGuidance loading>{t().loadingChats}</InlineGuidance>
        </Show>
        <Show when={!intent?.pending() && options.error}>
          <DialogError message={t().requestFailed} />
          <Button variant="text" onClick={() => void refetch()}>
            {t().retry}
          </Button>
        </Show>
        <Show when={intent?.pending() || (!options.loading && !options.error)}>
          <Show
            when={
              !intent?.pending() && !options()?.allowAuthenticated && entries().some((entry) => entry.principal.type === "authenticated")
            }
          >
            <InlineGuidance tone="warning">
              {t().authenticatedDiscoveryDisabled} {t().removeDisabledAudience}
            </InlineGuidance>
          </Show>
          <fieldset class="flex flex-col gap-2" disabled={locked()}>
            <legend class="mb-2 text-sm font-medium">{t().discoverableFor}</legend>
            <Show when={!recovering()}>
              <Select
                label={t().joiningPermission}
                disabled={locked()}
                value={permission}
                onValueChange={(value) => {
                  if (value === "read" || value === "write") setPermission(value);
                }}
                options={[
                  { id: "read", label: t().permissionRead },
                  { id: "write", label: t().permissionWrite },
                ]}
              />
              <Show
                when={
                  !options.error && options()?.allowAuthenticated && !entries().some((entry) => entry.principal.type === "authenticated")
                }
              >
                <Button variant="secondary" disabled={locked()} onClick={() => choose({ type: "authenticated" }, t().allAuthenticated)}>
                  {t().allAuthenticated}
                </Button>
              </Show>
              <Show when={!props.guest}>
                <Combobox
                  aria-label={t().findGroup}
                  placeholder={t().findGroup}
                  disabled={locked() || entries().length >= MEMBER_PAGE_SIZE}
                  fetchData={async (search, signal) => {
                    if (search.trim().length < 2) return [];
                    const url = new URL("/api/accounts/entities", location.href);
                    url.searchParams.set("search", search.trim());
                    url.searchParams.set("kinds", "group");
                    url.searchParams.set("per_page", "10");
                    const response = await fetch(url, { signal, credentials: "same-origin" });
                    if (!response.ok) throw new Error(t().requestFailed);
                    const result = z
                      .object({
                        items: z.array(z.object({ kind: z.literal("group"), group: z.object({ id: z.uuid(), name: z.string() }) })),
                      })
                      .parse(await response.json());
                    return result.items
                      .filter(
                        (item) =>
                          item.kind === "group" &&
                          !entries().some((entry) => entry.principal.type === "group" && entry.principal.groupId === item.group.id),
                      )
                      .map((item) => ({ id: item.group.id, label: item.group.name, icon: "ti-users-group" }));
                  }}
                  onSelect={(group) => choose({ type: "group", groupId: group.id }, group.label)}
                />
              </Show>
            </Show>
            <ul class="flex flex-col gap-2" aria-label={t().discoverableFor}>
              <For each={entries()}>
                {(entry) => (
                  <li class="flex items-center gap-2">
                    <span class="min-w-0 flex-1 text-sm">{entry.displayName}</span>
                    <Select
                      aria-label={`${t().joiningPermission}: ${entry.displayName}`}
                      disabled={locked()}
                      value={() => entry.permission}
                      onValueChange={(next) => {
                        if (next === "read" || next === "write")
                          setEntries(entries().map((known) => (known === entry ? { ...known, permission: next } : known)));
                      }}
                      options={[
                        { id: "read", label: t().permissionRead },
                        { id: "write", label: t().permissionWrite },
                      ]}
                    />
                    <IconButton
                      label={t().removeName({ name: entry.displayName })}
                      disabled={locked()}
                      variant="ghost"
                      size="sm"
                      onClick={() => setEntries(entries().filter((known) => known !== entry))}
                    >
                      <i class="ti ti-x" />
                    </IconButton>
                  </li>
                )}
              </For>
            </ul>
          </fieldset>
          <Show when={entries().some((entry) => entry.principal.type === "authenticated")}>
            <p class="text-sm text-dimmed">{t().authenticatedExplanation}</p>
          </Show>
          <Show when={!intent?.pending() && countLoading()}>
            <InlineGuidance loading>{t().loadingChats}</InlineGuidance>
          </Show>
          <Show when={!intent?.pending() && previewError()}>
            <DialogError message={t().requestFailed} />
            <Button variant="text" onClick={() => void preview()}>
              {t().retry}
            </Button>
          </Show>
          <Show when={!recovering() && count() !== undefined}>
            <p role="status" class="text-sm text-secondary">
              {t().discoveryAudience({ count: count()! })}
            </p>
          </Show>
        </Show>
      </form>
      <Show when={intent?.pending() && !busy()}>
        <p class="text-sm text-dimmed" role="status">
          {t().createRecovery}
        </p>
      </Show>
      <Show when={error()}>
        <DialogError message={error()} />
      </Show>
      <DialogActions>
        <Button variant="secondary" disabled={busy()} onClick={cancel}>
          {t().cancel}
        </Button>
        <Button
          type="submit"
          form="chat-channel"
          loading={busy()}
          disabled={
            !intent?.pending() &&
            (options.loading ||
              !!options.error ||
              countLoading() ||
              previewError() ||
              count() === undefined ||
              (!props.conversation && !entries().length))
          }
        >
          {props.conversation ? t().save : recovering() ? t().retry : t().newChannel}
        </Button>
      </DialogActions>
    </div>
  );
}
