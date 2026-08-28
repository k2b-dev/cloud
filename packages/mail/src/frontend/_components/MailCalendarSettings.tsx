import { mutation, query } from "@k2b/stdlib/solid";
import { Button, Placeholder, prompts, Select, SettingsField, SettingsGroup, SettingsSaveBar, toast, useLocale } from "@k2b/ui";
import { createEffect, createMemo, createSignal, onCleanup, Show } from "solid-js";
import { apiClient } from "../../api/client";
import { readApiError } from "./api-response";
import { mailSettingsMessages } from "./mail-settings-messages";

export default function MailCalendarSettings(props: { mailboxId: string; onDirtyChange?: (dirty: boolean) => void }) {
  const locale = useLocale();
  const messages = createMemo(() => mailSettingsMessages.resolve([locale()]).t);
  const [savedSpaceId, setSavedSpaceId] = createSignal<string | null>(null);
  const [spaceId, setSpaceId] = createSignal<string | null>(null);
  const [items, setItems] = createSignal<Array<{ id: string; name: string; color: string }>>([]);

  const destinations = query.create({
    source: () => props.mailboxId,
    load: async (mailboxId: string, { abortSignal }: { abortSignal: AbortSignal }) => {
      const response = await apiClient.mailboxes[":mailboxId"]["calendar-destinations"].$get(
        { param: { mailboxId } },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await readApiError(response, messages().failedLoadCalendarDestinations));
      return response.json();
    },
  });

  const save = mutation.create<void, void>({
    mutation: async (_input, { abortSignal }) => {
      const response = await apiClient.mailboxes[":mailboxId"]["calendar-destination"].$put(
        { param: { mailboxId: props.mailboxId }, json: { spaceId: spaceId() } },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await readApiError(response, messages().failedSaveCalendarDestination));
      const data = await response.json();
      setSavedSpaceId(data.selectedSpaceId);
      setSpaceId(data.selectedSpaceId);
      setItems(data.items);
      toast.success(data.selectedSpaceId ? messages().defaultCalendarSaved : messages().defaultCalendarCleared);
    },
    onError: (error) => prompts.error(error.message),
  });

  createEffect(() => {
    const data = destinations.data();
    if (!data) return;
    setItems(data.items);
    const selected = data.items.some((item) => item.id === data.selectedSpaceId) ? data.selectedSpaceId : null;
    setSavedSpaceId(selected);
    setSpaceId(selected);
  });
  createEffect(() => props.onDirtyChange?.(spaceId() !== savedSpaceId()));
  onCleanup(() => {
    save.abort();
    props.onDirtyChange?.(false);
  });

  return (
    <SettingsGroup title={messages().defaultDestination} description={messages().defaultDestinationDescription}>
      <Show when={!destinations.loading()} fallback={<Placeholder state="loading" variant="compact" title={messages().loadingSpaces} />}>
        <Show
          when={!destinations.error()}
          fallback={
            <Placeholder
              state="error"
              variant="compact"
              title={messages().spacesUnavailable}
              description={destinations.error()?.message}
              action={
                <Button variant="secondary" size="sm" type="button" onClick={() => void destinations.refresh()}>
                  {messages().retry}
                </Button>
              }
            />
          }
        >
          <Show
            when={items().length > 0}
            fallback={
              <Placeholder
                state="empty"
                variant="compact"
                icon="ti ti-calendar-off"
                title={messages().noWritableSpaces}
                description={messages().noWritableSpacesDescription}
              />
            }
          >
            <SettingsField
              label={messages().defaultSpace}
              description={messages().defaultSpaceDescription}
              error={() => undefined}
              changed={() => spaceId() !== savedSpaceId()}
            >
              {(control) => (
                <Select
                  aria-label={messages().defaultSpace}
                  aria-describedby={control.describedBy()}
                  icon="ti ti-calendar-event"
                  value={() => spaceId() ?? null}
                  onValueChange={setSpaceId}
                  clearable
                  placeholder={messages().noDefaultSpace}
                  disabled={save.loading()}
                  options={items().map((item) => ({ id: item.id, label: item.name, color: item.color, icon: "ti ti-calendar-event" }))}
                />
              )}
            </SettingsField>
            <SettingsSaveBar
              changeCount={() => (spaceId() === savedSpaceId() ? 0 : 1)}
              loading={save.loading}
              onDiscard={() => setSpaceId(savedSpaceId())}
              onSave={() => save.mutate()}
              saveLabel={messages().saveCalendar}
            />
          </Show>
        </Show>
      </Show>
    </SettingsGroup>
  );
}
