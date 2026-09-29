import { clipboard } from "@k2b/stdlib/browser";
import { query } from "@k2b/stdlib/solid";
import {
  Button,
  ButtonLink,
  Dropdown,
  dialogCore,
  IconButton,
  InlineGuidance,
  NoticeCard,
  Paper,
  panelDialogOptions,
  prompts,
  SettingsCollection,
  Switch,
  Tag,
  Tooltip,
  toast,
  useLocale,
} from "@k2b/ui";
import { createEffect, createSignal, For, type JSX, on, onCleanup, onMount, Show } from "solid-js";
import { apiClient } from "../../../api/client";
import {
  type PublicSection,
  type PublicSectionInput,
  type PublicStatus,
  PublicStatusSchema,
  type Venue,
  type VenueDashboard,
  type VenueInput,
} from "../../../contracts";
import { venueMessages } from "../../../messages";
import { buildPublicVenueUrl } from "../../public-runtime";
import { PublicPageBody } from "../public-page-view";
import { PublicSectionDialog, sectionKindIcon, sectionKindLabel } from "./public-sections";
import { createActionKeys } from "./shift-actions";
import { readError } from "./utils";

/** Everything `PATCH /venues/{id}` needs, from a Venue as the server last confirmed it. */
const venueInput = (venue: Venue, publicEnabled: boolean): VenueInput => ({
  name: venue.name,
  icon: venue.icon,
  slug: venue.slug,
  description: venue.description,
  timezone: venue.timezone,
  openMode: venue.openMode,
  signupMode: venue.signupMode,
  publicEnabled,
  feedbackEnabled: venue.feedbackEnabled,
  accentColor: venue.accentColor,
  logoBase64: venue.logoBase64,
  bannerBase64: venue.bannerBase64,
});

/** Stands in for the feedback form: the preview must not send feedback. */
function FeedbackPreview() {
  const locale = useLocale();
  const t = () => venueMessages.resolve([locale()]).t;
  return (
    <Paper as="section" class="grid gap-1 p-4">
      <h2 class="text-base font-semibold text-primary">{t().visitQuestion}</h2>
      <p class="text-sm text-secondary">{t().feedbackPreviewNote}</p>
    </Paper>
  );
}

/**
 * The admin's Public page view: the public page switch and its links, the sections in their public order, and a
 * preview that renders the page with the public page's own components, also while the page is off.
 */
export function PublicPageEditor(props: {
  dashboard: VenueDashboard;
  /** The public page as the server previews it; `null` when that failed. */
  initialPreview: PublicStatus | null;
  /** A section an old section link named: its row and its place in the preview are marked. */
  initialSectionId: string | null;
  /** Reloads the workspace after a change and announces `successMessage`; resolves to whether that worked. */
  reconcile: (successMessage?: string) => Promise<boolean>;
}) {
  const locale = useLocale();
  const t = () => venueMessages.resolve([locale()]).t;
  const venue = () => props.dashboard.venue;
  const actions = createActionKeys();
  let disposed = false;
  let list: HTMLDivElement | undefined;

  const previewQuery = query.create({
    source: () => venue().id,
    initial: { source: venue().id, data: props.initialPreview },
    load: async (venueId, { abortSignal }) => {
      const response = await apiClient.venues[":id"]["public-preview"].$get({ param: { id: venueId } }, { init: { signal: abortSignal } });
      if (!response.ok) throw new Error(await readError(response, t().previewFailed));
      return PublicStatusSchema.parse(await response.json());
    },
  });
  const refreshPreview = () => previewQuery.invalidate().catch(() => undefined);
  // Every confirmed change reloads the workspace data, so the preview follows it, also changes made in the settings.
  createEffect(
    on(
      () => props.dashboard,
      () => void refreshPreview(),
      { defer: true },
    ),
  );
  const previewFailed = () => Boolean(previewQuery.error()) || previewQuery.data() === null;

  const [selectedSectionId] = createSignal(props.initialSectionId);
  onMount(() => {
    const id = selectedSectionId();
    if (id) list?.querySelector(`[data-section-row="${id}"]`)?.scrollIntoView({ block: "nearest" });
  });

  /** One dialog at a time; a second click while a dialog is on its way does nothing. */
  const [prompting, setPrompting] = createSignal(false);
  const runPromptedAction = async <T,>(readIntent: () => Promise<T>, applyIntent: (intent: T) => Promise<void>) => {
    if (prompting()) return;
    setPrompting(true);
    try {
      const intent = await readIntent();
      if (!disposed) await applyIntent(intent);
    } finally {
      setPrompting(false);
    }
  };

  // The public page switch reads the Venue fresh before it saves, so it never writes back settings someone else
  // changed meanwhile.
  const [publicPending, setPublicPending] = createSignal<boolean | null>(null);
  const publicEnabled = () => publicPending() ?? venue().publicEnabled;
  const setPublicPage = (enabled: boolean) => {
    const venueId = venue().id;
    setPublicPending(enabled);
    void actions
      .run(["public-page"], async (signal) => {
        const fresh = await apiClient.venues[":id"]["settings-context"].$get({ param: { id: venueId } }, { init: { signal } });
        if (!fresh.ok) throw new Error(await readError(fresh, t().publicPageSwitchFailed));
        const current = (await fresh.json()).venue;
        const saved = await apiClient.venues[":id"].$patch(
          { param: { id: venueId }, json: venueInput(current, enabled) },
          { init: { signal } },
        );
        if (!saved.ok) throw new Error(await readError(saved, t().publicPageSwitchFailed));
        await props.reconcile(enabled ? t().publicPageTurnedOn : t().publicPageTurnedOff);
      })
      .finally(() => setPublicPending(null));
  };

  const [copying, setCopying] = createSignal<"page" | "monitor" | null>(null);
  const copyLink = async (kind: "page" | "monitor") => {
    setCopying(kind);
    try {
      const options = kind === "monitor" ? ({ height: "full", refresh: true } as const) : {};
      await clipboard.copy(buildPublicVenueUrl(window.location.origin, venue().id, options));
      toast.success(kind === "monitor" ? t().monitorLinkCopied : t().publicPageLinkCopied);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t().copyPublicPageFailed);
    } finally {
      setCopying(null);
    }
  };

  // Sections in their public order. A move shows at once and saves in the background; moves made while a save or
  // the reload after it runs are saved right after it, so quick keyboard moves never race each other.
  const [order, setOrder] = createSignal<string[] | null>(null);
  const sections = (): PublicSection[] => {
    const ids = order();
    if (!ids) return props.dashboard.sections;
    const byId = new Map(props.dashboard.sections.map((section) => [section.id, section]));
    return [...ids.flatMap((id) => byId.get(id) ?? []), ...props.dashboard.sections.filter((section) => !ids.includes(section.id))];
  };
  /** Adding, copying, deleting, and reordering change the set of sections, so they wait for each other. */
  const SET_KEY = "sections:set";
  const sectionKey = (id: string) => `section:${id}`;
  const [orderSaving, setOrderSaving] = createSignal(false);
  const [announcement, setAnnouncement] = createSignal("");
  let orderDirty = false;
  /** The row and control that had focus when a move started; the list renders its rows anew after a move. */
  let focusAfterMove: { id: string; direction: -1 | 1 } | null = null;

  const restoreFocus = () => {
    const target = focusAfterMove;
    if (!target || !list) return;
    // Focus stays where it is unless the move took it away: the row rendered anew, or its control got disabled.
    const active = document.activeElement as HTMLButtonElement | null;
    if (active && active !== document.body && active.isConnected && !active.disabled) return;
    const row = list.querySelector(`[data-section-row="${target.id}"]`)?.closest("li");
    const [up, down] = Array.from(row?.querySelectorAll<HTMLButtonElement>(".k2b-settings-collection__item-actions button") ?? []);
    const preferred = target.direction === -1 ? up : down;
    const fallback = target.direction === -1 ? down : up;
    (preferred && !preferred.disabled ? preferred : fallback)?.focus();
  };
  createEffect(on(sections, () => queueMicrotask(restoreFocus), { defer: true }));
  // Fresh workspace data carries the confirmed order; a local one only bridges a running save.
  createEffect(
    on(
      () => props.dashboard,
      () => {
        if (!orderSaving()) setOrder(null);
      },
      { defer: true },
    ),
  );

  const saveOrder = () => {
    orderDirty = true;
    if (orderSaving()) return;
    setOrderSaving(true);
    const venueId = venue().id;
    void actions
      .run([SET_KEY], async (signal) => {
        let reloaded = false;
        do {
          while (orderDirty) {
            orderDirty = false;
            const sectionIds = order();
            if (!sectionIds) return;
            const response = await apiClient.venues[":id"].sections.order.$put(
              { param: { id: venueId }, json: { sectionIds } },
              { init: { signal } },
            );
            if (!response.ok) throw new Error(await readError(response, t().reorderSectionsFailed));
          }
          reloaded = await props.reconcile();
          // A move made during the reload is not in the reloaded order yet, so it saves next.
        } while (orderDirty);
        // Until the workspace shows the saved order, the list keeps showing it.
        if (reloaded) setOrder(null);
      })
      .then((saved) => {
        if (saved) return;
        // A failed save falls back to the order the server confirmed, which an earlier save may have changed.
        setOrder(null);
        void props.reconcile();
      })
      .finally(() => {
        setOrderSaving(false);
        focusAfterMove = null;
      });
  };

  const move = (section: PublicSection, direction: -1 | 1) => {
    const ids = sections().map((entry) => entry.id);
    const from = ids.indexOf(section.id);
    const to = from + direction;
    if (from < 0 || to < 0 || to >= ids.length) return;
    [ids[from], ids[to]] = [ids[to]!, ids[from]!];
    focusAfterMove = { id: section.id, direction };
    setOrder(ids);
    setAnnouncement(t().sectionMoved({ title: section.title, position: to + 1, count: ids.length }));
    saveOrder();
  };
  // Another change of the set waits; a running order save accepts further moves.
  const reorderBlocked = () => actions.pending(SET_KEY) && !orderSaving();

  const [pendingVisibility, setPendingVisibility] = createSignal<{ id: string; enabled: boolean } | null>(null);
  const visible = (section: PublicSection) => {
    const pending = pendingVisibility();
    return pending?.id === section.id ? pending.enabled : section.enabled;
  };
  const setVisible = (section: PublicSection, enabled: boolean) => {
    const venueId = venue().id;
    setPendingVisibility({ id: section.id, enabled });
    void actions
      .run([sectionKey(section.id), `${sectionKey(section.id)}:visibility`], async (signal) => {
        const response = await apiClient.venues[":id"].sections[":resourceId"].$patch(
          { param: { id: venueId, resourceId: section.id }, json: { enabled } },
          { init: { signal } },
        );
        if (!response.ok) throw new Error(await readError(response, t().updateSectionFailed));
        await props.reconcile(enabled ? t().sectionShown : t().sectionHidden);
      })
      // A failed save leaves the confirmed state, so the switch flips back.
      .finally(() => setPendingVisibility(null));
  };

  const openAdd = () => {
    const intent = {
      venueId: venue().id,
      nextPosition: Math.max(0, ...props.dashboard.sections.map((section) => section.position)) + 1,
      publicPageEnabled: venue().publicEnabled,
    };
    return runPromptedAction(
      () =>
        dialogCore.open<boolean>(
          (close, context) => (
            <PublicSectionDialog
              close={close}
              guardDismiss={context.setDismissHandler}
              nextPosition={intent.nextPosition}
              publicPageEnabled={intent.publicPageEnabled}
              submit={async (input) => {
                const response = await apiClient.venues[":id"].sections.$post({ param: { id: intent.venueId }, json: input });
                return response.ok ? null : await readError(response, t().addSectionFailed);
              }}
            />
          ),
          panelDialogOptions,
        ),
      async (saved) => {
        if (saved) await props.reconcile(t().sectionAdded);
      },
    );
  };

  const openEdit = (section: PublicSection) => {
    const intent = {
      venueId: venue().id,
      section: { ...section, content: { ...section.content } },
      publicPageEnabled: venue().publicEnabled,
    };
    return runPromptedAction(
      () =>
        dialogCore.open<boolean>(
          (close, context) => (
            <PublicSectionDialog
              close={close}
              guardDismiss={context.setDismissHandler}
              initial={intent.section}
              nextPosition={intent.section.position}
              publicPageEnabled={intent.publicPageEnabled}
              title={t().editPublicSection}
              submitLabel={t().saveSection}
              submit={async ({ position: _position, ...patch }) => {
                // The position stays out of an edit, so saving never undoes a reorder made meanwhile.
                const response = await apiClient.venues[":id"].sections[":resourceId"].$patch({
                  param: { id: intent.venueId, resourceId: intent.section.id },
                  json: patch,
                });
                return response.ok ? null : await readError(response, t().updateSectionFailed);
              }}
            />
          ),
          panelDialogOptions,
        ),
      async (saved) => {
        if (saved) await props.reconcile(t().sectionUpdated);
      },
    );
  };

  /** A copy starts as a draft at the end, so the public page never shows the same section twice by accident. */
  const duplicate = (section: PublicSection) => {
    const venueId = venue().id;
    const input: PublicSectionInput = {
      kind: section.kind,
      title: t().sectionCopy({ title: section.title }),
      content: { ...section.content },
      enabled: false,
      position: Math.max(0, ...props.dashboard.sections.map((entry) => entry.position)) + 1,
    };
    void actions.run([SET_KEY, `${sectionKey(section.id)}:copy`], async (signal) => {
      const response = await apiClient.venues[":id"].sections.$post({ param: { id: venueId }, json: input }, { init: { signal } });
      if (!response.ok) throw new Error(await readError(response, t().duplicateSectionFailed));
      await props.reconcile(t().sectionDuplicated);
    });
  };

  const confirmDelete = (section: PublicSection) => {
    const intent = { venueId: venue().id, id: section.id, title: section.title };
    return runPromptedAction(
      () =>
        prompts.confirm(t().deletePublicSectionQuestion({ title: intent.title }), {
          title: t().deletePublicSection,
          variant: "danger",
          confirmText: t().delete,
        }),
      async (confirmed) => {
        if (!confirmed) return;
        await actions.run([SET_KEY, sectionKey(intent.id), `${sectionKey(intent.id)}:delete`], async (signal) => {
          const response = await apiClient.venues[":id"].sections[":resourceId"].$delete(
            { param: { id: intent.venueId, resourceId: intent.id } },
            { init: { signal } },
          );
          if (!response.ok) throw new Error(await readError(response, t().deleteSectionFailed));
          await props.reconcile(t().sectionDeleted);
        });
      },
    );
  };

  onCleanup(() => {
    disposed = true;
    actions.abortAll();
  });

  const SectionRow = (row: { section: PublicSection; index: number }): JSX.Element => (
    <SettingsCollection.Item
      title={
        <span data-section-row={row.section.id} data-selected={selectedSectionId() === row.section.id ? "" : undefined}>
          {row.section.title}
        </span>
      }
      description={sectionKindLabel(row.section.kind, t())}
      icon={<i class={sectionKindIcon(row.section.kind)} aria-hidden="true" />}
    >
      <Show when={!row.section.enabled}>
        <SettingsCollection.Item.Status>
          <Tag size="sm" icon="ti ti-eye-off">
            {t().sectionDraft}
          </Tag>
        </SettingsCollection.Item.Status>
      </Show>
      <SettingsCollection.Item.Actions>
        <SettingsCollection.Item.Reorder
          label={row.section.title}
          index={row.index}
          count={sections().length}
          disabled={reorderBlocked()}
          onMove={(direction) => move(row.section, direction)}
        />
        <Tooltip.Anchor content={t().showOnPublicPage}>
          {/* A 44 px target, so the switch works with a finger. */}
          <Switch
            aria-label={t().sectionVisibleLabel({ title: row.section.title })}
            value={visible(row.section)}
            disabled={actions.pending(sectionKey(row.section.id))}
            onValueChange={(enabled) => setVisible(row.section, enabled)}
            class="[&_.k2b-switch]:min-h-11 [&_.k2b-switch]:min-w-11 [&_.k2b-switch]:justify-center"
          />
        </Tooltip.Anchor>
        <IconButton
          label={t().editSectionNamed({ title: row.section.title })}
          size="sm"
          disabled={actions.pending(sectionKey(row.section.id)) || prompting()}
          onClick={() => void openEdit(row.section)}
        >
          <i class="ti ti-pencil" aria-hidden="true" />
        </IconButton>
        <Dropdown.Root
          align="end"
          disabled={actions.pending(sectionKey(row.section.id))}
          items={[
            {
              label: t().duplicateSection,
              icon: "ti ti-copy",
              disabled: actions.pending(SET_KEY),
              action: () => duplicate(row.section),
            },
            {
              label: t().deleteSection,
              icon: "ti ti-trash",
              variant: "danger",
              disabled: actions.pending(SET_KEY),
              action: () => void confirmDelete(row.section),
            },
          ]}
        >
          <Dropdown.Trigger iconOnly size="sm" label={t().sectionActions({ title: row.section.title })}>
            <i class="ti ti-dots" aria-hidden="true" />
          </Dropdown.Trigger>
        </Dropdown.Root>
      </SettingsCollection.Item.Actions>
    </SettingsCollection.Item>
  );

  return (
    <div class="flex flex-col gap-3" data-public-page-editor="">
      <div class="paper flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between" data-public-page-bar="">
        <Switch
          label={t().publicPageOn}
          value={publicEnabled()}
          disabled={actions.pending("public-page")}
          onValueChange={setPublicPage}
          class="[&_.k2b-switch]:min-h-11"
        />
        <div class="flex flex-wrap gap-2">
          <Button type="button" variant="secondary" size="sm" loading={copying() === "page"} onClick={() => void copyLink("page")}>
            <i class="ti ti-copy" aria-hidden="true" /> {t().copyPageLink}
          </Button>
          <Button type="button" variant="secondary" size="sm" loading={copying() === "monitor"} onClick={() => void copyLink("monitor")}>
            <i class="ti ti-device-tv" aria-hidden="true" /> {t().copyMonitorLink}
          </Button>
          <ButtonLink
            href={`/app/venue/public/${venue().id}`}
            target="_blank"
            rel="noreferrer"
            variant="secondary"
            size="sm"
            title={t().openPublicPageLabel}
          >
            <i class="ti ti-external-link" aria-hidden="true" /> {t().openPublicPage}
          </ButtonLink>
        </div>
      </div>
      <Show when={!publicEnabled()}>
        <InlineGuidance tone="info" icon="ti ti-world-off">
          {t().publicPageOffNotice}
        </InlineGuidance>
      </Show>

      {/* Below 1024 px the list stacks above the preview. */}
      <div class="grid items-start gap-4 lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
        <div class="paper p-3" ref={list} data-public-sections="">
          <SettingsCollection
            title={t().sections}
            description={t().sectionsDescription}
            empty={t().noSections}
            class="[&_li:has([data-selected])]:bg-[var(--k2b-hover)]"
          >
            <SettingsCollection.Action>
              <Button type="button" size="sm" disabled={actions.pending(SET_KEY) || prompting()} onClick={() => void openAdd()}>
                <i class="ti ti-plus" aria-hidden="true" /> {t().addSection}
              </Button>
            </SettingsCollection.Action>
            <For each={sections()}>{(section, index) => <SectionRow section={section} index={index()} />}</For>
          </SettingsCollection>
          <p class="sr-only" aria-live="polite">
            {announcement()}
          </p>
        </div>

        <section class="flex min-w-0 flex-col gap-2" aria-labelledby="venue-public-preview-heading" data-public-preview="">
          <div class="px-1">
            <h2 id="venue-public-preview-heading" class="text-sm font-semibold text-primary">
              {t().preview}
            </h2>
            <p class="text-xs text-dimmed">{venue().publicEnabled ? t().previewLiveDescription : t().previewOffDescription}</p>
          </div>
          <Show when={previewFailed()}>
            <NoticeCard tone="danger" title={t().previewFailed} data-preview-error="">
              <Button type="button" variant="secondary" size="sm" loading={previewQuery.refreshing()} onClick={() => void refreshPreview()}>
                {t().retry}
              </Button>
            </NoticeCard>
          </Show>
          <Show when={previewQuery.data()}>
            {(status) => (
              <div class="flex min-w-0 flex-col gap-4 rounded-xl border border-zinc-200 p-3 sm:p-4 dark:border-zinc-800">
                <PublicPageBody status={status()} layout="preview" selectedSectionId={selectedSectionId()} feedback={<FeedbackPreview />} />
              </div>
            )}
          </Show>
        </section>
      </div>
    </div>
  );
}
