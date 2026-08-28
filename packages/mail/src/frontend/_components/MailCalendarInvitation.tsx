import { documentNavigate } from "@k2b/ssr/nav";
import { type DateContext, dates } from "@k2b/stdlib";
import { mutation, query } from "@k2b/stdlib/solid";
import { Button, ButtonLink, Placeholder, prompts, Select, StatusBadge, toast, useLocale } from "@k2b/ui";
import { createEffect, createMemo, createSignal, onCleanup, Show } from "solid-js";
import { apiClient } from "../../api/client";
import { readApiError } from "./api-response";
import { mailDraftHref } from "./mail-compose-route";
import { mailRemainingMessages } from "./mail-remaining-messages";

export default function MailCalendarInvitation(props: {
  mailboxId: string;
  messageId: string;
  requestUrl: string;
  canWrite: boolean;
  dateConfig: DateContext;
}) {
  const locale = useLocale();
  const messages = createMemo(() => mailRemainingMessages.resolve([locale()]).t);
  const [selectedSpaceId, setSelectedSpaceId] = createSignal<string | null>(null);
  const [pendingResponse, setPendingResponse] = createSignal<"accepted" | "tentative" | "declined" | null>(null);
  let responseIdempotencyKeys = new Map<"accepted" | "tentative" | "declined", string>();
  let destinationTouched = false;

  const chooseSpace = (spaceId: string | null) => {
    destinationTouched = true;
    responseIdempotencyKeys = new Map();
    setSelectedSpaceId(spaceId);
  };
  const reconcileDestination = () => {
    if (destinationTouched) return;
    const available = destinations();
    if (!available) return;
    const existingSpaceId = preview()?.existing?.spaceId ?? null;
    setSelectedSpaceId(
      existingSpaceId
        ? available.items.some((space) => space.id === existingSpaceId)
          ? existingSpaceId
          : null
        : (available.selectedSpaceId ?? available.items[0]?.id ?? null),
    );
  };
  const responseIdempotencyKey = (participationStatus: "accepted" | "tentative" | "declined") => {
    const existing = responseIdempotencyKeys.get(participationStatus);
    if (existing) return existing;
    const created = crypto.randomUUID();
    responseIdempotencyKeys.set(participationStatus, created);
    return created;
  };

  const previewQuery = query.create({
    source: () => `${props.mailboxId}:${props.messageId}`,
    load: async (_source, { abortSignal }) => {
      const response = await apiClient.mailboxes[":mailboxId"].messages[":messageId"]["calendar-invitation"].$get(
        { param: { mailboxId: props.mailboxId, messageId: props.messageId } },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await readApiError(response, messages().couldNotReadInvitation));
      return response.json();
    },
  });
  const destinationQuery = query.create({
    source: () => props.mailboxId,
    enabled: () => props.canWrite,
    load: async (mailboxId, { abortSignal }) => {
      const response = await apiClient.mailboxes[":mailboxId"]["calendar-destinations"].$get(
        { param: { mailboxId } },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await readApiError(response, messages().couldNotLoadCalendarDestinations));
      return response.json();
    },
  });
  const preview = previewQuery.data;
  const destinations = destinationQuery.data;
  createEffect(reconcileDestination);

  const importEvent = mutation.create<void, void>({
    mutation: async (_input, { abortSignal }) => {
      const response = await apiClient.mailboxes[":mailboxId"].messages[":messageId"]["calendar-invitation"].import.$post(
        {
          param: { mailboxId: props.mailboxId, messageId: props.messageId },
          json: selectedSpaceId() ? { spaceId: selectedSpaceId()! } : {},
        },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await readApiError(response, messages().couldNotAddEvent));
      const result = await response.json();
      toast.success(
        result.outcome === "created"
          ? messages().eventAdded
          : result.outcome === "unchanged"
            ? messages().eventUpToDate
            : messages().eventUpdated,
      );
      try {
        await previewQuery.invalidate();
      } catch (error) {
        void prompts.error(error instanceof Error ? error.message : messages().invitationRefreshFailed, {
          title: messages().eventImportedRefreshFailed,
        });
      }
    },
  });

  const respond = mutation.create<void, "accepted" | "tentative" | "declined">({
    onBefore: (participationStatus) => setPendingResponse(participationStatus),
    mutation: async (participationStatus, { abortSignal }) => {
      const response = await apiClient.mailboxes[":mailboxId"].messages[":messageId"]["calendar-invitation"].respond.$post(
        {
          param: { mailboxId: props.mailboxId, messageId: props.messageId },
          json: {
            participationStatus,
            idempotencyKey: responseIdempotencyKey(participationStatus),
            ...(selectedSpaceId() ? { spaceId: selectedSpaceId()! } : {}),
          },
        },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await readApiError(response, messages().couldNotCreateCalendarResponse));
      const draft = await response.json();
      documentNavigate(mailDraftHref(props.mailboxId, draft.id, props.requestUrl));
    },
    onFinally: () => setPendingResponse(null),
  });

  const invitation = () => preview()?.invitation;
  const isCancelled = () => invitation()?.method === "cancel" || invitation()?.status === "cancelled";
  const linkedSpaceIsWritable = () => {
    const existingSpaceId = preview()?.existing?.spaceId;
    return !existingSpaceId || destinationOptions().some((space) => space.id === existingSpaceId);
  };
  const hasWritableDestination = () => linkedSpaceIsWritable() && destinationOptions().some((space) => space.id === selectedSpaceId());
  const canRespond = () =>
    props.canWrite && hasWritableDestination() && invitation()?.method === "request" && Boolean(invitation()?.organizer) && !isCancelled();
  const destinationOptions = createMemo(() =>
    (destinations()?.items ?? []).map((space) => ({ id: space.id, label: space.name, color: space.color, icon: "ti ti-calendar-event" })),
  );

  onCleanup(() => {
    importEvent.abort();
    respond.abort();
  });

  return (
    <div class="mt-3 min-h-24 rounded-[var(--ui-radius-surface)] bg-[var(--ui-surface-subtle)] p-3">
      <Show
        when={preview()}
        fallback={
          <Placeholder
            state={previewQuery.error() ? "error" : "loading"}
            variant="compact"
            title={previewQuery.error() ? messages().invitationUnavailable : messages().readingInvitation}
            description={previewQuery.error()?.message}
            action={
              previewQuery.error() ? (
                <Button variant="secondary" size="sm" type="button" onClick={() => void previewQuery.refresh()}>
                  {messages().retry}
                </Button>
              ) : undefined
            }
          />
        }
      >
        {(value) => (
          <div class="flex flex-col gap-3">
            <div class="flex items-start gap-3">
              <span class={`mail-calendar-invitation-icon shrink-0 ${isCancelled() ? "text-danger" : "text-accent"}`}>
                <i class={`ti ${isCancelled() ? "ti-calendar-cancel" : "ti-calendar-event"}`} aria-hidden="true" />
              </span>
              <div class="min-w-0 flex-1">
                <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <h3 class="truncate text-sm font-semibold text-primary">{value().invitation.title}</h3>
                  <Show when={isCancelled()}>
                    <StatusBadge tone="error" label={messages().cancelled} />
                  </Show>
                </div>
                <p class="mt-0.5 text-xs text-secondary">
                  {dates.formatDateTime(value().invitation.startsAt, props.dateConfig)} –{" "}
                  {dates.formatDateTime(value().invitation.endsAt, props.dateConfig)}
                </p>
                <Show when={value().invitation.location}>
                  {(location) => (
                    <p class="mt-0.5 truncate text-xs text-dimmed">
                      <i class="ti ti-map-pin mr-1" aria-hidden="true" />
                      {location()}
                    </p>
                  )}
                </Show>
                <Show when={value().invitation.organizer}>
                  {(organizer) => (
                    <p class="mt-0.5 truncate text-xs text-dimmed">
                      {messages().organizedBy({ organizer: organizer().name ?? organizer().address })}
                    </p>
                  )}
                </Show>
                <Show when={value().response}>
                  {(response) => (
                    <p class="mt-1 text-xs text-secondary">
                      <i class="ti ti-edit mr-1" aria-hidden="true" />
                      {messages().responseDraftPrepared({
                        response:
                          response().participationStatus === "accepted"
                            ? messages().acceptance
                            : response().participationStatus === "tentative"
                              ? messages().tentativeResponse
                              : messages().decline,
                      })}
                    </p>
                  )}
                </Show>
              </div>
            </div>

            <Show when={props.canWrite}>
              <div class="flex flex-wrap items-end gap-2">
                <Show when={!value().existing && destinationOptions().length > 1}>
                  <div class="min-w-48 flex-1">
                    <Select
                      aria-label={messages().destinationSpace}
                      value={() => selectedSpaceId() ?? null}
                      onValueChange={chooseSpace}
                      options={destinationOptions()}
                      placeholder={messages().chooseSpace}
                    />
                  </div>
                </Show>
                <Show
                  when={value().existing}
                  fallback={
                    <Button
                      variant="secondary"
                      size="sm"
                      type="button"
                      loading={importEvent.loading()}
                      loadingLabel={messages().addingToSpaces}
                      disabled={!selectedSpaceId()}
                      onClick={() => importEvent.mutate()}
                    >
                      <i class="ti ti-calendar-plus" aria-hidden="true" />
                      {messages().addToSpaces}
                    </Button>
                  }
                >
                  {(existing) => (
                    <ButtonLink variant="secondary" size="sm" href={existing().href} target="_blank" rel="noreferrer">
                      <i class="ti ti-external-link" aria-hidden="true" />
                      {messages().openInSpaces}
                    </ButtonLink>
                  )}
                </Show>
                <Show when={canRespond()}>
                  <div class="flex flex-wrap gap-1">
                    <Button
                      size="sm"
                      type="button"
                      loading={respond.loading() && pendingResponse() === "accepted"}
                      loadingLabel={messages().preparingAcceptance}
                      disabled={respond.loading() || importEvent.loading()}
                      onClick={() => respond.mutate("accepted")}
                    >
                      <i class="ti ti-check" aria-hidden="true" /> {messages().accept}
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      type="button"
                      loading={respond.loading() && pendingResponse() === "tentative"}
                      loadingLabel={messages().preparingTentativeResponse}
                      disabled={respond.loading() || importEvent.loading()}
                      onClick={() => respond.mutate("tentative")}
                    >
                      {messages().maybe}
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      type="button"
                      loading={respond.loading() && pendingResponse() === "declined"}
                      loadingLabel={messages().preparingDecline}
                      disabled={respond.loading() || importEvent.loading()}
                      onClick={() => respond.mutate("declined")}
                    >
                      {messages().decline}
                    </Button>
                  </div>
                </Show>
              </div>
            </Show>
            <Show when={importEvent.error() || respond.error()}>
              <p class="text-xs text-danger" role="alert">
                {importEvent.error()?.message ?? respond.error()?.message}
              </p>
            </Show>
            <Show when={props.canWrite && destinationQuery.loading()}>
              <Placeholder state="loading" variant="compact" align="left" title={messages().loadingWritableSpaces} />
            </Show>
            <Show when={props.canWrite && destinationQuery.error()}>
              <Placeholder
                state="error"
                variant="compact"
                align="left"
                title={messages().writableSpacesUnavailable}
                description={destinationQuery.error()?.message}
                action={
                  <Button variant="secondary" size="sm" type="button" onClick={() => void destinationQuery.refresh()}>
                    {messages().retry}
                  </Button>
                }
              />
            </Show>
            <Show when={props.canWrite && value().existing && destinations() && !linkedSpaceIsWritable()}>
              <p class="text-xs text-dimmed">{messages().linkedSpaceNotWritable}</p>
            </Show>
            <Show when={props.canWrite && destinations() && destinationOptions().length === 0}>
              <Placeholder
                state="empty"
                variant="compact"
                align="left"
                icon="ti ti-calendar-off"
                title={messages().noWritableSpace}
                description={messages().askSpaceOwner}
              />
            </Show>
          </div>
        )}
      </Show>
    </div>
  );
}
