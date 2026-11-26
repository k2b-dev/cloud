import { clipboard } from "@k2b/stdlib/browser";
import { query } from "@k2b/stdlib/solid";
import { dialogCore, Paper, panelDialogOptions, useLocale } from "@k2b/ui";
import {
  Button,
  Canvas,
  Check,
  Dialog,
  Empty,
  Failed,
  List,
  Menu,
  type MenuEntry,
  Pane,
  Row,
  Section,
  StatusRow,
  Text,
  useToast,
} from "@k2b/ui/v2";
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
import { screenMessages } from "../../screens/messages";
import { iconName } from "../../screens/VenueOverviewScreen";
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
  const words = () => screenMessages.resolve([locale()]).t;
  const toast = useToast();
  const venue = () => props.dashboard.venue;
  const actions = createActionKeys((message) => toast(message, { status: "bad" }));
  let disposed = false;

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
      toast(kind === "monitor" ? t().monitorLinkCopied : t().publicPageLinkCopied, { status: "ok" });
    } catch (error) {
      toast(error instanceof Error ? error.message : t().copyPublicPageFailed, { status: "bad" });
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

  const moveLabel = (direction: -1 | 1, title: string) => `${direction === -1 ? words().moveUp : words().moveDown}: ${title}`;
  const restoreFocus = () => {
    const target = focusAfterMove;
    if (!target) return;
    // Focus stays where it is unless the move took it away: the row rendered anew, or its control got disabled.
    const active = document.activeElement as HTMLButtonElement | null;
    if (active && active !== document.body && active.isConnected && !active.disabled) return;
    const section = sections().find((entry) => entry.id === target.id);
    if (!section) return;
    const button = (direction: -1 | 1) =>
      document.querySelector<HTMLButtonElement>(`button[aria-label="${CSS.escape(moveLabel(direction, section.title))}"]`);
    const preferred = button(target.direction);
    const fallback = button(target.direction === -1 ? 1 : -1);
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
        Dialog.confirm({
          title: t().deletePublicSection,
          description: t().deletePublicSectionQuestion({ title: intent.title }),
          confirm: t().delete,
          cancel: t().cancel,
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

  const sectionMenu = (section: PublicSection): MenuEntry[] => [
    {
      label: t().showOnPublicPage,
      icon: "world",
      checked: visible(section),
      disabled: actions.pending(sectionKey(section.id)),
      onClick: () => setVisible(section, !visible(section)),
    },
    "separator",
    { label: t().editPublicSection, icon: "pencil", disabled: prompting(), onClick: () => void openEdit(section) },
    { label: t().duplicateSection, icon: "copy", disabled: actions.pending(SET_KEY), onClick: () => duplicate(section) },
    {
      label: t().deleteSection,
      icon: "trash",
      danger: true,
      disabled: actions.pending(SET_KEY),
      onClick: () => void confirmDelete(section),
    },
  ];
  return (
    <Pane.Split>
      <Pane
        label={t().sections}
        width={{ min: 360, default: 520 }}
        scrollKey={`venue-public-${venue().id}`}
        status={<StatusRow lead={words().sectionsCount({ count: sections().length })} loading={orderSaving()} />}
      >
        <Section
          icon="world"
          title={t().publicPage}
          summary={publicEnabled() ? t().previewLiveDescription : t().publicPageOffNotice}
          actions={[{ label: t().copyPageLink, icon: "copy", disabled: copying() !== null, onClick: () => void copyLink("page") }]}
        >
          <Check
            switch
            label={t().publicPageOn}
            checked={publicEnabled()}
            disabled={actions.pending("public-page")}
            onChange={setPublicPage}
          />
          <Row icon="external-link" lines={[t().openPublicPage, t().openPublicPageLabel]} href={`/app/venue/public/${venue().id}`} />
          <Row
            icon="device-tv"
            lines={[t().copyMonitorLink, t().fullDisplayDescription]}
            action={{ label: t().copyLink, icon: "copy", disabled: copying() !== null, onClick: () => void copyLink("monitor") }}
          />
        </Section>
        <Section
          icon="layout-list"
          title={t().sections}
          count={sections().length}
          summary={t().sectionsDescription}
          actions={[
            { label: t().addSection, icon: "plus", disabled: actions.pending(SET_KEY) || prompting(), onClick: () => void openAdd() },
          ]}
        >
          <Show when={sections().length > 0} fallback={<Empty icon="layout-list" text={t().noSections} />}>
            <List label={t().sections}>
              <For each={sections()}>
                {(section, index) => (
                  <Row
                    icon={iconName(sectionKindIcon(section.kind))}
                    current={selectedSectionId() === section.id}
                    lines={[
                      section.title,
                      section.enabled
                        ? sectionKindLabel(section.kind, t())
                        : `${sectionKindLabel(section.kind, t())} · ${t().sectionDraft}`,
                    ]}
                    end={
                      <>
                        <Button
                          variant="ghost"
                          icon="arrow-up"
                          label={moveLabel(-1, section.title)}
                          disabled={reorderBlocked() || index() === 0}
                          onClick={() => move(section, -1)}
                        />
                        <Button
                          variant="ghost"
                          icon="arrow-down"
                          label={moveLabel(1, section.title)}
                          disabled={reorderBlocked() || index() === sections().length - 1}
                          onClick={() => move(section, 1)}
                        />
                        <Menu
                          label={t().sectionActions({ title: section.title })}
                          disabled={actions.pending(sectionKey(section.id))}
                          items={sectionMenu(section)}
                        />
                      </>
                    }
                  />
                )}
              </For>
            </List>
          </Show>
          {/* k2b-ui gap: no live region in v2; the move is announced to assistive technology here. */}
          <Text type="meta" muted>
            <span role="status" aria-live="polite">
              {announcement()}
            </span>
          </Text>
        </Section>
      </Pane>
      <Pane
        label={t().preview}
        scrollKey={`venue-preview-${venue().id}`}
        status={<StatusRow lead={t().preview} loading={previewQuery.refreshing()} />}
      >
        <Show when={!previewFailed()} fallback={<Failed text={t().previewFailed} onRetry={() => void refreshPreview()} />}>
          <Show when={previewQuery.data()}>
            {(status) => (
              // k2b-ui gap: the public page is not on v2 yet; its own components draw the preview in a canvas.
              <Canvas label={t().preview}>
                <PublicPageBody status={status()} layout="preview" selectedSectionId={selectedSectionId()} feedback={<FeedbackPreview />} />
              </Canvas>
            )}
          </Show>
        </Show>
      </Pane>
    </Pane.Split>
  );
}
