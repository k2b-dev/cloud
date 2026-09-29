import { PermissionEditor, type ResourceApiKey, ResourceApiKeys } from "@k2b/cloud/access/ui";
import type { AccessEntry, PermissionLevel, Principal } from "@k2b/cloud/contracts";
import { navigateTo } from "@k2b/ssr/nav";
import { dates } from "@k2b/stdlib";
import { mutation } from "@k2b/stdlib/solid";
import {
  Button,
  CheckboxCard,
  ColorInput,
  confirmDiscardIfDirty,
  Disclosure,
  dialogCore,
  IconInput,
  ImageInput,
  NoticeCard,
  Placeholder,
  panelDialogOptions,
  prompts,
  SegmentedControl,
  Select,
  SettingsCollection,
  SettingsField,
  SettingsGroup,
  SettingsModal,
  SettingsPanelFooter,
  Switch,
  Tag,
  TextInput,
  Tooltip,
  toast,
  useLocale,
} from "@k2b/ui";
import { createEffect, createMemo, createSignal, For, type JSX, onCleanup, Show } from "solid-js";
import { apiClient } from "../../../api/client";
import type {
  DateOverride,
  DateOverrideInput,
  OpeningRule,
  OpeningRuleInput,
  ShiftTemplate,
  ShiftTemplateInput,
  Venue,
  VenueDashboard,
  VenueInput,
} from "../../../contracts";
import { type VenueMessages, venueMessages } from "../../../messages";
import { formatDateKey } from "../../../time-format";
import { createVenueSettingsQuery, settingsCloseBlocked, settingsInteractionBlocked } from "../../settings-contract";
import { venueSlugError } from "../../venue-slug";
import { type DialogSubmit, ExceptionDialog, OpeningRuleDialog, ScheduleActionButton, ShiftTemplateDialog } from "./schedule";
import { bannerTransform, readError, sortOpeningRules, sortOverrides, sortShiftTemplates } from "./utils";

/** The settings tabs another view can open directly. */
export type VenueSettingsTab = "general" | "access" | "schedule" | "danger";

/** A slug that no other venue has yet is required; the server answers 409 when it is taken. */
class VenueSlugTakenError extends Error {}

/** `Special opening 18:00–23:00 · Long night`: an exception's kind, its times, and its note. */
const describeException = (entry: DateOverride, t: VenueMessages): string =>
  [
    entry.kind === "open" && entry.startTime && entry.endTime
      ? t.specialOpening({ window: `${entry.startTime}–${entry.endTime}` })
      : t.closed,
    entry.note,
  ]
    .filter(Boolean)
    .join(" · ");

/** Every IANA time zone this runtime knows, plus the venue's own when the list lacks it. */
const timeZoneOptions = (current: string) => {
  let zones: string[];
  try {
    zones = Intl.supportedValuesOf("timeZone");
  } catch {
    zones = [];
  }
  return [...new Set([current, ...zones])].sort().map((zone) => ({ id: zone, label: zone.replaceAll("_", " ") }));
};

/** Weekdays in calendar order, Monday first. */
const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;

export function VenueDangerZone(props: { venue: Venue; onPendingChange: (pending: boolean) => void }) {
  const locale = useLocale();
  const t = () => venueMessages.resolve([locale()]).t;
  let disposed = false;
  let confirming = false;
  const remove = mutation.create<void, { venueId: string }>({
    mutation: async ({ venueId }, { abortSignal }) => {
      const res = await apiClient.venues[":id"].$delete({ param: { id: venueId } }, { init: { signal: abortSignal } });
      if (!res.ok) throw new Error(await readError(res, t().deleteVenueFailed));
    },
    onSuccess: () => navigateTo("/app/venue"),
    onError: (err) => prompts.error(err.message),
  });
  const handleDelete = async () => {
    if (confirming || remove.loading()) return;
    confirming = true;
    props.onPendingChange(true);
    try {
      const intent = { venueId: props.venue.id, venueName: props.venue.name };
      // Deleting removes shifts, sign-ups, feedback, and the public page for good, so it takes the typed name.
      // The prompt accepts only a single-line phrase; a name with a line break falls back to the slug.
      const phrase = /[\r\n\t]/.test(intent.venueName) ? props.venue.slug : intent.venueName;
      const confirmed = await prompts.confirm(t().deleteVenueQuestion({ name: intent.venueName }), {
        title: t().deleteVenue,
        icon: "ti ti-trash",
        variant: "danger",
        confirmText: t().deleteVenue,
        confirmationPhrase: phrase,
      });
      if (disposed || !confirmed) return;
      await remove.mutate({ venueId: intent.venueId });
    } finally {
      confirming = false;
      if (!disposed) props.onPendingChange(false);
    }
  };

  onCleanup(() => {
    disposed = true;
    remove.abort();
    props.onPendingChange(false);
  });

  return (
    <Button type="button" variant="danger" onClick={handleDelete} loading={remove.loading()} loadingLabel={t().deleting} class="self-start">
      <i class="ti ti-trash" aria-hidden="true" />
      {t().deleteVenue}
    </Button>
  );
}

export function SettingsDialog(props: {
  dashboard: VenueDashboard;
  accessEntries: AccessEntry[];
  apiKeys: ResourceApiKey[];
  /** The tab to show first, for example `schedule` from the setup checklist. */
  initialTab?: VenueSettingsTab;
  /** Receives the access list whenever the dialog loads or changes it, so the workspace can follow. */
  onAccessEntriesChange?: (entries: AccessEntry[]) => void;
  close: (changed: boolean) => void;
}) {
  const locale = useLocale();
  const t = () => venueMessages.resolve([locale()]).t;
  const weekday = (value: number) =>
    new Intl.DateTimeFormat(locale(), { weekday: "long", timeZone: "UTC" }).format(new Date(Date.UTC(2026, 0, 4 + value)));
  const exceptionDate = (entry: DateOverride) =>
    formatDateKey(entry.date, locale(), { weekday: "short", day: "numeric", month: "numeric", year: "numeric" });
  const venue = props.dashboard.venue;
  const initialContext = {
    venue,
    openingRules: props.dashboard.openingRules,
    overrides: props.dashboard.overrides,
    templates: props.dashboard.templates,
    accessEntries: props.accessEntries,
    apiKeys: props.apiKeys,
  };
  const settingsQuery = createVenueSettingsQuery({
    venueId: venue.id,
    initial: initialContext,
    load: async (venueId, abortSignal) => {
      const response = await apiClient.venues[":id"]["settings-context"].$get(
        { param: { id: venueId } },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await readError(response, t().refreshSettingsFailed));
      return await response.json();
    },
  });
  const settings = () => settingsQuery.data() ?? initialContext;
  const currentVenue = () => settings().venue;
  const [workspaceChanged, setWorkspaceChanged] = createSignal(false);
  const [name, setName] = createSignal(venue.name);
  const [icon, setIcon] = createSignal(venue.icon || "ti ti-building-carousel");
  const [slug, setSlug] = createSignal(venue.slug);
  const [slugTaken, setSlugTaken] = createSignal(false);
  const [description, setDescription] = createSignal(venue.description ?? "");
  const [openMode, setOpenMode] = createSignal<Venue["openMode"]>(venue.openMode);
  const [signupMode, setSignupMode] = createSignal<Venue["signupMode"]>(venue.signupMode);
  const [timezone, setTimezone] = createSignal(venue.timezone);
  const [publicEnabled, setPublicEnabled] = createSignal(venue.publicEnabled);
  const [accentColor, setAccentColor] = createSignal(venue.accentColor);
  const [feedbackEnabled, setFeedbackEnabled] = createSignal(venue.feedbackEnabled);
  const [logo, setLogo] = createSignal(venue.logoBase64);
  const [banner, setBanner] = createSignal(venue.bannerBase64);
  const [generalDirty, setGeneralDirty] = createSignal(false);
  const openingRules = () => sortOpeningRules(settings().openingRules);
  /** Today in the venue's time zone: exceptions before it are past. */
  const venueToday = () => dates.formatDateKey(new Date(), { timeZone: currentVenue().timezone });
  const upcomingOverrides = () => sortOverrides(settings().overrides).filter((entry) => entry.date >= venueToday());
  const pastOverrides = () =>
    sortOverrides(settings().overrides)
      .filter((entry) => entry.date < venueToday())
      .reverse();
  const shiftsByWeekday = () => {
    const templates = sortShiftTemplates(settings().templates);
    return WEEKDAY_ORDER.map((day) => ({ weekday: day, templates: templates.filter((template) => template.weekday === day) })).filter(
      (group) => group.templates.length > 0,
    );
  };
  const zones = createMemo(() => timeZoneOptions(currentVenue().timezone));

  let disposed = false;
  const [settingsHydrated, setSettingsHydrated] = createSignal(false);
  const [prompting, setPrompting] = createSignal(false);
  const [writePending, setWritePending] = createSignal(false);
  const [reconciling, setReconciling] = createSignal(false);
  const [reconciliationFailed, setReconciliationFailed] = createSignal(false);
  const [dangerPending, setDangerPending] = createSignal(false);
  const [requestCount, setRequestCount] = createSignal(0);
  /** The row whose delete or pause is running; only that row shows progress. */
  const [busyRow, setBusyRow] = createSignal<string | null>(null);
  /** The shift whose pause or resume is saving: its switch shows the asked state until the server answers. */
  const [pendingPause, setPendingPause] = createSignal<{ id: string; active: boolean } | null>(null);
  const [activeTab, setActiveTab] = createSignal<string>(props.initialTab ?? "general");
  const requestControllers = new Set<AbortController>();
  const runRequest = async <T,>(request: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    if (writePending() || reconciling()) throw new Error(t().waitForSettings);
    setWritePending(true);
    setRequestCount((count) => count + 1);
    const controller = new AbortController();
    requestControllers.add(controller);
    try {
      const result = await request(controller.signal);
      if (disposed) {
        const error = new Error(t().settingsClosed);
        error.name = "AbortError";
        throw error;
      }
      return result;
    } finally {
      requestControllers.delete(controller);
      setRequestCount((count) => Math.max(0, count - 1));
      setWritePending(false);
    }
  };
  const reconcileSettings = async (successMessage: string) => {
    try {
      await settingsQuery.invalidate();
      if (disposed) return;
      setReconciliationFailed(false);
      toast.success(successMessage);
    } catch {
      if (disposed) return;
      setReconciliationFailed(true);
      prompts.error(t().savedSettingsRefreshFailed);
    }
  };
  const retrySettingsRead = async () => {
    await settingsQuery.refresh();
    if (!settingsQuery.error()) setReconciliationFailed(false);
  };
  const finishSettingsChange = async (successMessage: string) => {
    setWorkspaceChanged(true);
    setReconciling(true);
    try {
      await reconcileSettings(successMessage);
    } finally {
      setReconciling(false);
    }
  };
  const settingsWriteBlocked = () =>
    writePending() || reconciling() || requestCount() > 0 || settingsQuery.refreshing() || Boolean(settingsQuery.error());
  type SettingsMutation<V> = { mutate: (value: V) => Promise<void>; error: () => Error | null | undefined };
  /** Runs a confirmed row action; `row` names the row that shows progress. */
  const runReconciledMutation = async <V,>(control: SettingsMutation<V>, value: V, successMessage: string, row: string) => {
    if (settingsWriteBlocked()) return;
    setWritePending(true);
    setBusyRow(row);
    try {
      await control.mutate(value);
      if (disposed || control.error()) return;
      await finishSettingsChange(successMessage);
    } finally {
      setWritePending(false);
      setBusyRow(null);
    }
  };
  /** Saves from inside a dialog: the dialog stays open with its input and shows why a save failed. */
  const dialogSubmit =
    <V,>(control: SettingsMutation<V>): DialogSubmit<V> =>
    async (value) => {
      if (settingsWriteBlocked()) return t().waitForSettings;
      setWritePending(true);
      try {
        await control.mutate(value);
        if (disposed) return null;
        return control.error()?.message ?? null;
      } finally {
        setWritePending(false);
      }
    };
  const runPromptedAction = async <T,>(readIntent: () => Promise<T>, applyIntent: (intent: T) => Promise<void>) => {
    if (prompting()) return;
    setPrompting(true);
    try {
      const intent = await readIntent();
      if (disposed) return;
      await applyIntent(intent);
    } finally {
      setPrompting(false);
    }
  };
  /** Opens a dialog that saves on its own and refreshes the settings once it closed after a save. */
  const openSavingDialog = async (
    render: (close: (saved: boolean) => void, guardDismiss: (handler: () => void) => void) => JSX.Element,
    successMessage: () => string,
  ) => {
    await runPromptedAction(
      () => dialogCore.open<boolean>((close, context) => render(close, context.setDismissHandler), panelDialogOptions),
      async (saved) => {
        if (saved) await finishSettingsChange(successMessage());
      },
    );
  };

  createEffect(() => {
    const fresh = settingsQuery.data();
    if (!fresh || fresh === initialContext) return;
    setSettingsHydrated(true);
    if (generalDirty()) return;
    const next = fresh.venue;
    setName(next.name);
    setIcon(next.icon || "ti ti-building-carousel");
    setSlug(next.slug);
    setDescription(next.description ?? "");
    setOpenMode(next.openMode);
    setSignupMode(next.signupMode);
    setTimezone(next.timezone);
    setPublicEnabled(next.publicEnabled);
    setAccentColor(next.accentColor);
    setFeedbackEnabled(next.feedbackEnabled);
    setLogo(next.logoBase64);
    setBanner(next.bannerBase64);
  });
  createEffect(() => props.onAccessEntriesChange?.(settings().accessEntries));

  const venueInput = (): VenueInput => ({
    name: name(),
    icon: icon(),
    slug: slug(),
    description: description().trim() || null,
    timezone: timezone(),
    openMode: openMode(),
    signupMode: signupMode(),
    publicEnabled: publicEnabled(),
    feedbackEnabled: feedbackEnabled(),
    accentColor: accentColor(),
    logoBase64: logo(),
    bannerBase64: banner(),
  });
  const generalChangeCount = () => {
    const draft = venueInput();
    const confirmed = currentVenue();
    return (
      Number(draft.name !== confirmed.name) +
      Number(draft.icon !== (confirmed.icon || "ti ti-building-carousel")) +
      Number(draft.slug !== confirmed.slug) +
      Number(draft.description !== (confirmed.description ?? null)) +
      Number(draft.openMode !== confirmed.openMode) +
      Number(draft.signupMode !== confirmed.signupMode) +
      Number(draft.timezone !== confirmed.timezone) +
      Number(draft.publicEnabled !== confirmed.publicEnabled) +
      Number(draft.feedbackEnabled !== confirmed.feedbackEnabled) +
      Number(draft.accentColor !== confirmed.accentColor) +
      Number(draft.logoBase64 !== confirmed.logoBase64) +
      Number(draft.bannerBase64 !== confirmed.bannerBase64)
    );
  };
  const nameError = () => (!name().trim() ? t().nameRequired : undefined);
  const slugError = () => venueSlugError(slug(), t()) ?? (slugTaken() ? t().slugTaken : undefined);
  const discardGeneral = () => {
    const confirmed = currentVenue();
    setName(confirmed.name);
    setIcon(confirmed.icon || "ti ti-building-carousel");
    setSlug(confirmed.slug);
    setSlugTaken(false);
    setDescription(confirmed.description ?? "");
    setOpenMode(confirmed.openMode);
    setSignupMode(confirmed.signupMode);
    setTimezone(confirmed.timezone);
    setPublicEnabled(confirmed.publicEnabled);
    setAccentColor(confirmed.accentColor);
    setFeedbackEnabled(confirmed.feedbackEnabled);
    setLogo(confirmed.logoBase64);
    setBanner(confirmed.bannerBase64);
    setGeneralDirty(false);
  };
  /** Marks General as edited and applies the change. */
  const edit =
    <T,>(set: (value: T) => void) =>
    (value: T) => {
      setGeneralDirty(true);
      set(value);
    };
  const save = mutation.create<void, VenueInput>({
    mutation: async (input, { abortSignal }) => {
      const res = await apiClient.venues[":id"].$patch(
        {
          param: { id: venue.id },
          json: input,
        },
        { init: { signal: abortSignal } },
      );
      if (res.status === 409) throw new VenueSlugTakenError(t().slugTaken);
      if (!res.ok) throw new Error(await readError(res, t().saveVenueFailed));
    },
    onError: (err) => {
      if (err instanceof VenueSlugTakenError) setSlugTaken(true);
      else prompts.error(err.message);
    },
  });
  const saveSettings = async () => {
    if (settingsWriteBlocked() || nameError() || slugError()) return;
    setWritePending(true);
    try {
      await save.mutate(venueInput());
      if (disposed || save.error()) return;
      setWorkspaceChanged(true);
      toast.success(t().venueSaved);
      props.close(true);
    } finally {
      setWritePending(false);
    }
  };

  const createOpening = mutation.create<void, OpeningRuleInput>({
    mutation: async (input, { abortSignal }) => {
      const res = await apiClient.venues[":id"]["opening-rules"].$post(
        { param: { id: venue.id }, json: input },
        { init: { signal: abortSignal } },
      );
      if (!res.ok) throw new Error(await readError(res, t().addOpeningFailed));
    },
  });
  const openCreateOpening = () =>
    openSavingDialog(
      (close, guardDismiss) => <OpeningRuleDialog close={close} guardDismiss={guardDismiss} submit={dialogSubmit(createOpening)} />,
      () => t().openingAdded,
    );

  const editOpening = mutation.create<void, { id: string; input: OpeningRuleInput }>({
    mutation: async ({ id, input }, { abortSignal }) => {
      const res = await apiClient.venues[":id"]["opening-rules"][":resourceId"].$patch(
        { param: { id: venue.id, resourceId: id }, json: input },
        { init: { signal: abortSignal } },
      );
      if (!res.ok) throw new Error(await readError(res, t().updateOpeningFailed));
    },
  });
  const openEditOpening = (rule: OpeningRule) => {
    const target = { id: rule.id, initial: { ...rule } };
    const submit = dialogSubmit(editOpening);
    return openSavingDialog(
      (close, guardDismiss) => (
        <OpeningRuleDialog
          close={close}
          guardDismiss={guardDismiss}
          initial={target.initial}
          submit={(input) => submit({ id: target.id, input })}
        />
      ),
      () => t().openingUpdated,
    );
  };

  const deleteOpening = mutation.create<void, string>({
    mutation: async (id, { abortSignal }) => {
      const res = await apiClient.venues[":id"]["opening-rules"][":resourceId"].$delete(
        { param: { id: venue.id, resourceId: id } },
        { init: { signal: abortSignal } },
      );
      if (!res.ok) throw new Error(await readError(res, t().deleteOpeningFailed));
    },
    onError: (err) => prompts.error(err.message),
  });
  const confirmDeleteOpening = async (rule: OpeningRule) => {
    const target = { id: rule.id, label: `${weekday(rule.weekday)} ${rule.startTime}–${rule.endTime}` };
    await runPromptedAction(
      () =>
        prompts.confirm(t().deleteOpeningQuestion({ label: target.label }), {
          title: t().deleteOpening,
          variant: "danger",
          confirmText: t().delete,
        }),
      async (confirmed) => {
        if (confirmed) await runReconciledMutation(deleteOpening, target.id, t().openingDeleted, `opening:${target.id}`);
      },
    );
  };

  const addException = mutation.create<void, DateOverrideInput>({
    mutation: async (input, { abortSignal }) => {
      const res = await apiClient.venues[":id"].overrides.$post(
        { param: { id: venue.id }, json: input },
        { init: { signal: abortSignal } },
      );
      if (!res.ok) throw new Error(await readError(res, t().addExceptionFailed));
    },
  });
  // Adding saves through the upsert route, which would replace another exception on the same date without a word.
  const openAddException = () => {
    const timezone = currentVenue().timezone;
    const takenDates = settings().overrides.map((entry) => entry.date);
    return openSavingDialog(
      (close, guardDismiss) => (
        <ExceptionDialog
          close={close}
          guardDismiss={guardDismiss}
          timeZone={timezone}
          today={venueToday()}
          takenDates={takenDates}
          submit={dialogSubmit(addException)}
        />
      ),
      () => t().exceptionAdded,
    );
  };

  const editException = mutation.create<void, { id: string; input: DateOverrideInput }>({
    mutation: async ({ id, input }, { abortSignal }) => {
      const res = await apiClient.venues[":id"].overrides[":resourceId"].$patch(
        { param: { id: venue.id, resourceId: id }, json: input },
        { init: { signal: abortSignal } },
      );
      if (res.status === 409) throw new Error(t().exceptionDateTaken);
      if (!res.ok) throw new Error(await readError(res, t().updateExceptionFailed));
    },
  });
  const openEditException = (entry: DateOverride) => {
    const target = {
      id: entry.id,
      initial: { ...entry },
      timezone: currentVenue().timezone,
      takenDates: settings()
        .overrides.filter((other) => other.id !== entry.id)
        .map((other) => other.date),
    };
    const submit = dialogSubmit(editException);
    return openSavingDialog(
      (close, guardDismiss) => (
        <ExceptionDialog
          close={close}
          guardDismiss={guardDismiss}
          timeZone={target.timezone}
          initial={target.initial}
          takenDates={target.takenDates}
          submit={(input) => submit({ id: target.id, input })}
        />
      ),
      () => t().exceptionUpdated,
    );
  };

  const deleteException = mutation.create<void, string>({
    mutation: async (id, { abortSignal }) => {
      const res = await apiClient.venues[":id"].overrides[":resourceId"].$delete(
        { param: { id: venue.id, resourceId: id } },
        { init: { signal: abortSignal } },
      );
      if (!res.ok) throw new Error(await readError(res, t().deleteExceptionFailed));
    },
    onError: (err) => prompts.error(err.message),
  });
  const confirmDeleteException = async (entry: DateOverride) => {
    const target = { id: entry.id, date: exceptionDate(entry) };
    await runPromptedAction(
      () =>
        prompts.confirm(t().deleteExceptionQuestion({ date: target.date }), {
          title: t().deleteException,
          variant: "danger",
          confirmText: t().delete,
        }),
      async (confirmed) => {
        if (confirmed) await runReconciledMutation(deleteException, target.id, t().exceptionDeleted, `exception:${target.id}`);
      },
    );
  };

  const createShifts = mutation.create<void, ShiftTemplateInput[]>({
    mutation: async (templates, { abortSignal }) => {
      const res = await apiClient.venues[":id"].templates.batch.$post(
        { param: { id: venue.id }, json: { templates } },
        { init: { signal: abortSignal } },
      );
      if (!res.ok) throw new Error(await readError(res, t().addShiftFailed));
    },
  });
  const openCreateShift = () => {
    let count = 1;
    const submit = dialogSubmit(createShifts);
    return openSavingDialog(
      (close, guardDismiss) => (
        <ShiftTemplateDialog
          close={close}
          guardDismiss={guardDismiss}
          submit={(inputs) => {
            count = inputs.length;
            return submit(inputs);
          }}
        />
      ),
      () => (count > 1 ? t().shiftsAdded({ count }) : t().shiftAdded),
    );
  };

  const editShift = mutation.create<void, { id: string; input: ShiftTemplateInput }>({
    mutation: async ({ id, input }, { abortSignal }) => {
      const res = await apiClient.venues[":id"].templates[":resourceId"].$patch(
        { param: { id: venue.id, resourceId: id }, json: input },
        { init: { signal: abortSignal } },
      );
      if (!res.ok) throw new Error(await readError(res, t().updateShiftFailed));
    },
  });
  const openEditShift = (shift: ShiftTemplate) => {
    const target = { id: shift.id, initial: { ...shift } };
    const submit = dialogSubmit(editShift);
    return openSavingDialog(
      (close, guardDismiss) => (
        <ShiftTemplateDialog
          close={close}
          guardDismiss={guardDismiss}
          initial={target.initial}
          submit={([input]) => (input ? submit({ id: target.id, input }) : Promise.resolve(t().updateShiftFailed))}
        />
      ),
      () => t().shiftUpdated,
    );
  };
  /** Pauses or resumes a shift at once: a paused shift keeps its settings but plans no more slots. */
  const pauseShift = mutation.create<void, { id: string; input: ShiftTemplateInput }>({
    mutation: async ({ id, input }, { abortSignal }) => {
      const res = await apiClient.venues[":id"].templates[":resourceId"].$patch(
        { param: { id: venue.id, resourceId: id }, json: input },
        { init: { signal: abortSignal } },
      );
      if (!res.ok) throw new Error(await readError(res, input.active ? t().resumeShiftFailed : t().pauseShiftFailed));
    },
    onError: (err) => prompts.error(err.message),
  });
  const setShiftActive = async (shift: ShiftTemplate, active: boolean) => {
    const { id, venueId: _venueId, createdAt: _createdAt, updatedAt: _updatedAt, ...input } = shift;
    setPendingPause({ id, active });
    try {
      await runReconciledMutation(
        pauseShift,
        { id, input: { ...input, active } },
        active ? t().shiftResumed : t().shiftPaused,
        `pause:${id}`,
      );
    } finally {
      // A failed save leaves the confirmed state, so the switch flips back.
      setPendingPause(null);
    }
  };
  const shiftSwitchValue = (shift: ShiftTemplate) => {
    const pending = pendingPause();
    return pending?.id === shift.id ? pending.active : shift.active;
  };

  const deleteShift = mutation.create<void, string>({
    mutation: async (id, { abortSignal }) => {
      const res = await apiClient.venues[":id"].templates[":resourceId"].$delete(
        { param: { id: venue.id, resourceId: id } },
        { init: { signal: abortSignal } },
      );
      if (!res.ok) throw new Error(await readError(res, t().deleteShiftFailed));
    },
    onError: (err) => prompts.error(err.message),
  });
  const confirmDeleteShift = async (shift: ShiftTemplate) => {
    const target = { id: shift.id, title: shift.title };
    await runPromptedAction(
      () =>
        prompts.confirm(t().deleteShiftQuestion({ title: target.title }), {
          title: t().deleteShift,
          variant: "danger",
          confirmText: t().delete,
        }),
      async (confirmed) => {
        if (confirmed) await runReconciledMutation(deleteShift, target.id, t().shiftDeleted, `shift:${target.id}`);
      },
    );
  };

  const mutationPending = () =>
    save.loading() ||
    createOpening.loading() ||
    editOpening.loading() ||
    deleteOpening.loading() ||
    addException.loading() ||
    editException.loading() ||
    deleteException.loading() ||
    createShifts.loading() ||
    editShift.loading() ||
    pauseShift.loading() ||
    deleteShift.loading();
  const interactionState = () => ({
    prompting: prompting(),
    writePending: writePending(),
    reconciling: reconciling(),
    coverageError: reconciliationFailed(),
    childPending: dangerPending(),
    requestCount: requestCount(),
    mutationPending: mutationPending(),
  });
  const settingsOperationBusy = () => settingsInteractionBlocked(interactionState());
  const closeBlocked = () => settingsCloseBlocked(interactionState());
  const scheduleBusy = () => settingsOperationBusy() || settingsQuery.refreshing() || Boolean(settingsQuery.error());
  const requestClose = () => {
    if (closeBlocked()) return;
    if (generalChangeCount() === 0) {
      props.close(workspaceChanged());
      return;
    }
    setPrompting(true);
    void confirmDiscardIfDirty(true)
      .then((confirmed) => {
        if (confirmed && !disposed) props.close(workspaceChanged());
      })
      .finally(() => {
        if (!disposed) setPrompting(false);
      });
  };
  const SettingsReadError = () => (
    <Show when={settingsQuery.error()}>
      <NoticeCard tone="danger" title={t().settingsRefreshTitle} detail={t().lastConfirmedData}>
        <Button type="button" variant="secondary" size="sm" disabled={settingsQuery.refreshing()} onClick={() => void retrySettingsRead()}>
          {t().retry}
        </Button>
      </NoticeCard>
    </Show>
  );
  /** Edit and delete for one row: only the row that runs an action shows progress; the others wait. */
  const RowActions = (rowProps: {
    row: string;
    editLabel: string;
    deleteLabel: string;
    onEdit: () => void;
    onDelete: () => void;
    children?: JSX.Element;
  }) => (
    <SettingsCollection.Item.Actions>
      {rowProps.children}
      <ScheduleActionButton
        label={rowProps.editLabel}
        icon="ti ti-pencil"
        tone="edit"
        disabled={scheduleBusy()}
        onClick={rowProps.onEdit}
      />
      <ScheduleActionButton
        label={rowProps.deleteLabel}
        icon="ti ti-trash"
        tone="delete"
        loading={busyRow() === rowProps.row}
        disabled={scheduleBusy() && busyRow() !== rowProps.row}
        onClick={rowProps.onDelete}
      />
    </SettingsCollection.Item.Actions>
  );
  const ExceptionItem = (itemProps: { entry: DateOverride }) => (
    <SettingsCollection.Item
      title={exceptionDate(itemProps.entry)}
      description={describeException(itemProps.entry, t())}
      icon={<i class={itemProps.entry.kind === "open" ? "ti ti-calendar-plus" : "ti ti-calendar-off"} aria-hidden="true" />}
    >
      <RowActions
        row={`exception:${itemProps.entry.id}`}
        editLabel={t().editException}
        deleteLabel={t().deleteException}
        onEdit={() => void openEditException(itemProps.entry)}
        onDelete={() => void confirmDeleteException(itemProps.entry)}
      />
    </SettingsCollection.Item>
  );

  onCleanup(() => {
    disposed = true;
    save.abort();
    createOpening.abort();
    editOpening.abort();
    deleteOpening.abort();
    addException.abort();
    editException.abort();
    deleteException.abort();
    createShifts.abort();
    editShift.abort();
    pauseShift.abort();
    deleteShift.abort();
    for (const controller of requestControllers) controller.abort();
    requestControllers.clear();
  });

  return (
    <div class="flex h-[86vh] min-h-0 flex-col overflow-hidden">
      <SettingsModal
        title={t().venueSettings}
        subtitle={currentVenue().name}
        icon={icon()}
        activeTab={activeTab()}
        onTabChange={(tab) => {
          if (!settingsOperationBusy()) setActiveTab(tab);
        }}
        onClose={requestClose}
        closeLabel={t().closeSettings}
      >
        <SettingsModal.Group title={t().venueGroup}>
          <SettingsModal.Tab id="general" title={t().general} icon="ti ti-id" description={t().generalDescription}>
            <SettingsReadError />
            <fieldset disabled={!settingsHydrated() || settingsWriteBlocked()} class="grid gap-6" data-settings-general="">
              <SettingsGroup title={t().identity} description={t().identityDescription}>
                <div class="grid gap-4 md:grid-cols-2">
                  <SettingsField
                    label={t().name}
                    description={t().nameDescription}
                    error={nameError}
                    changed={() => name() !== currentVenue().name}
                  >
                    <TextInput aria-label={t().name} value={name} onValueChange={edit(setName)} required />
                  </SettingsField>
                  <SettingsField
                    label={t().slug}
                    description={t().slugDescription}
                    error={slugError}
                    changed={() => slug() !== currentVenue().slug}
                  >
                    <TextInput
                      aria-label={t().slug}
                      value={slug}
                      onValueChange={(value) => {
                        setSlugTaken(false);
                        edit(setSlug)(value);
                      }}
                      required
                    />
                  </SettingsField>
                </div>
                <SettingsField
                  label={t().description}
                  description={t().publicDescriptionDescription}
                  error={() => undefined}
                  changed={() => description() !== (currentVenue().description ?? "")}
                >
                  <TextInput aria-label={t().description} value={description} onValueChange={edit(setDescription)} multiline lines={3} />
                </SettingsField>
              </SettingsGroup>

              <SettingsGroup title={t().scheduleRules} description={t().scheduleRulesDescription}>
                <div class="grid gap-4">
                  <SettingsField
                    label={t().publicOpeningLogic}
                    description={t().publicOpeningLogicDescription}
                    error={() => undefined}
                    changed={() => openMode() !== currentVenue().openMode}
                  >
                    <SegmentedControl<Venue["openMode"]>
                      ariaLabel={t().publicOpeningLogic}
                      value={openMode}
                      onValueChange={edit(setOpenMode)}
                      options={[
                        { value: "regular", label: t().regular, icon: "ti ti-clock" },
                        { value: "staffed", label: t().staffedMode, icon: "ti ti-users" },
                        { value: "combined", label: t().both, icon: "ti ti-arrows-join" },
                      ]}
                    />
                  </SettingsField>
                  <SettingsField
                    label={t().signupMode}
                    description={t().signupModeDescription}
                    error={() => undefined}
                    changed={() => signupMode() !== currentVenue().signupMode}
                  >
                    <SegmentedControl<Venue["signupMode"]>
                      ariaLabel={t().signupMode}
                      value={signupMode}
                      onValueChange={edit(setSignupMode)}
                      options={[
                        { value: "templates", label: t().signupModeShifts, icon: "ti ti-calendar-event" },
                        { value: "free", label: t().freeTime, icon: "ti ti-clock-plus" },
                        { value: "both", label: t().both, icon: "ti ti-arrows-join" },
                      ]}
                    />
                  </SettingsField>
                  <SettingsField
                    label={t().timezone}
                    description={t().timezoneDescription}
                    error={() => undefined}
                    changed={() => timezone() !== currentVenue().timezone}
                  >
                    <Select
                      aria-label={t().timezone}
                      value={timezone}
                      onValueChange={(value) => {
                        if (value) edit(setTimezone)(value);
                      }}
                      options={zones()}
                      searchable
                      clearable={false}
                    />
                  </SettingsField>
                </div>
              </SettingsGroup>

              <SettingsGroup title={t().publicPage} description={t().publicPageSettingDescription}>
                <CheckboxCard
                  label={t().publicPageOn}
                  description={t().publicPageOnDescription}
                  icon="ti ti-world"
                  value={publicEnabled}
                  onValueChange={edit(setPublicEnabled)}
                  variant="input"
                />
              </SettingsGroup>

              <SettingsGroup title={t().publicBranding} description={t().publicBrandingDescription}>
                <div class="grid gap-4 md:grid-cols-2">
                  <SettingsField
                    label={t().icon}
                    description={t().iconDescription}
                    error={() => undefined}
                    changed={() => icon() !== (currentVenue().icon || "ti ti-building-carousel")}
                  >
                    <IconInput
                      aria-label={t().icon}
                      value={icon}
                      onValueChange={(value) => edit(setIcon)(value ?? "ti ti-building-carousel")}
                      clearable={false}
                    />
                  </SettingsField>
                  <SettingsField
                    label={t().themeColor}
                    description={t().themeColorDescription}
                    error={() => undefined}
                    changed={() => accentColor() !== currentVenue().accentColor}
                  >
                    <ColorInput aria-label={t().themeColor} value={accentColor} onValueChange={edit(setAccentColor)} />
                  </SettingsField>
                  <SettingsField
                    label={t().logo}
                    description={t().logoDescription}
                    error={() => undefined}
                    changed={() => logo() !== currentVenue().logoBase64}
                  >
                    <ImageInput aria-label={t().logo} value={logo} onValueChange={edit(setLogo)} variant="small" />
                  </SettingsField>
                  <SettingsField
                    label={t().bannerImage}
                    description={t().bannerDescription}
                    error={() => undefined}
                    changed={() => banner() !== currentVenue().bannerBase64}
                  >
                    <ImageInput
                      aria-label={t().bannerImage}
                      value={banner}
                      onValueChange={edit(setBanner)}
                      variant="small"
                      transform={bannerTransform}
                    />
                  </SettingsField>
                </div>
              </SettingsGroup>

              <SettingsGroup title={t().visitorFeedback} description={t().visitorFeedbackDescription}>
                <CheckboxCard
                  label={t().feedbackActivated}
                  description={t().feedbackActivatedDescription}
                  icon="ti ti-message-star"
                  value={feedbackEnabled}
                  onValueChange={edit(setFeedbackEnabled)}
                  variant="input"
                />
              </SettingsGroup>
            </fieldset>
            <SettingsModal.Footer>
              <SettingsPanelFooter
                changeCount={generalChangeCount}
                loading={save.loading}
                saveDisabled={() => Boolean(nameError() || slugError())}
                onDiscard={discardGeneral}
                onSave={() => void saveSettings()}
              />
            </SettingsModal.Footer>
          </SettingsModal.Tab>
        </SettingsModal.Group>

        <SettingsModal.Group title={t().sharing}>
          <SettingsModal.Tab id="access" title={t().access} icon="ti ti-shield" description={t().accessDescription}>
            <SettingsReadError />
            <Show
              when={!settingsQuery.refreshing() && !settingsQuery.error()}
              fallback={<Placeholder align="left" description={<>{t().refreshBeforeAccess}</>} />}
            >
              <div class="grid gap-6">
                <SettingsGroup title={t().peopleAndGroups} description={t().peopleAndGroupsDescription}>
                  <Show keyed when={settings().accessEntries}>
                    {(entries) => (
                      <PermissionEditor
                        initialEntries={entries.filter((entry) => entry.principal.type !== "service_account")}
                        canEdit
                        allowedLevels={[
                          { level: "read", label: t().read },
                          { level: "write", label: t().staff },
                          { level: "admin", label: t().admin },
                        ]}
                        grantAccess={async (principal: Principal, permission: Exclude<PermissionLevel, "none">): Promise<AccessEntry> => {
                          const entry = await runRequest(async (abortSignal) => {
                            const response = await apiClient.venues[":id"].access.$post(
                              {
                                param: { id: venue.id },
                                json: { principal, permission },
                              },
                              { init: { signal: abortSignal } },
                            );
                            if (!response.ok) throw new Error(await readError(response, t().grantAccessFailed));
                            return response.json();
                          });
                          await finishSettingsChange(t().accessGranted);
                          return entry;
                        }}
                        updateAccess={async (accessId, permission) => {
                          await runRequest(async (abortSignal) => {
                            const response = await apiClient.venues[":id"].access[":accessId"].$patch(
                              {
                                param: { id: venue.id, accessId },
                                json: { permission },
                              },
                              { init: { signal: abortSignal } },
                            );
                            if (!response.ok) throw new Error(await readError(response, t().updateAccessFailed));
                          });
                          await finishSettingsChange(t().accessUpdated);
                        }}
                        revokeAccess={async (accessId) => {
                          await runRequest(async (abortSignal) => {
                            const response = await apiClient.venues[":id"].access[":accessId"].$delete(
                              { param: { id: venue.id, accessId } },
                              { init: { signal: abortSignal } },
                            );
                            if (!response.ok) throw new Error(await readError(response, t().revokeAccessFailed));
                          });
                          await finishSettingsChange(t().accessRevoked);
                        }}
                      />
                    )}
                  </Show>
                </SettingsGroup>
                <SettingsGroup title={t().integrationAccess} description={t().integrationAccessDescription}>
                  <ResourceApiKeys
                    title={t().apiKeys}
                    description={t().apiKeysDescription}
                    initialKeys={settings().apiKeys}
                    createKey={async (input) => {
                      const created = await runRequest(async (abortSignal) => {
                        const response = await apiClient.venues[":id"]["api-keys"].$post(
                          {
                            param: { id: venue.id },
                            json: input,
                          },
                          { init: { signal: abortSignal } },
                        );
                        if (!response.ok) throw new Error(await readError(response, t().createApiKeyFailed));
                        return (await response.json()) as { credential: ResourceApiKey; token: string };
                      });
                      await finishSettingsChange(t().apiKeyCreated);
                      return created;
                    }}
                    revokeKey={async (credentialId) => {
                      await runRequest(async (abortSignal) => {
                        const response = await apiClient.venues[":id"]["api-keys"][":credentialId"].$delete(
                          {
                            param: { id: venue.id, credentialId },
                          },
                          { init: { signal: abortSignal } },
                        );
                        if (!response.ok) throw new Error(await readError(response, t().revokeApiKeyFailed));
                      });
                      await finishSettingsChange(t().apiKeyRevoked);
                    }}
                  />
                </SettingsGroup>
              </div>
            </Show>
          </SettingsModal.Tab>
        </SettingsModal.Group>

        <SettingsModal.Group title={t().operations}>
          {/* Every change in this tab saves at once; the opening logic lives in General with its save bar. */}
          <SettingsModal.Tab id="schedule" title={t().schedule} icon="ti ti-calendar-time" description={t().operationsDescription}>
            <SettingsReadError />
            <div class="grid gap-6">
              <SettingsCollection title={t().regularHours} description={t().regularHoursDescription} empty={t().noRegularHours}>
                <SettingsCollection.Action>
                  <Button type="button" size="sm" disabled={scheduleBusy()} onClick={() => void openCreateOpening()}>
                    <i class="ti ti-plus" aria-hidden="true" /> {t().newHours}
                  </Button>
                </SettingsCollection.Action>
                <For each={openingRules()}>
                  {(rule) => (
                    <SettingsCollection.Item
                      title={weekday(rule.weekday)}
                      description={`${rule.startTime}–${rule.endTime}${rule.note ? ` · ${rule.note}` : ""}`}
                      icon={<i class="ti ti-clock" aria-hidden="true" />}
                    >
                      <RowActions
                        row={`opening:${rule.id}`}
                        editLabel={t().editOpening}
                        deleteLabel={t().deleteOpening}
                        onEdit={() => void openEditOpening(rule)}
                        onDelete={() => void confirmDeleteOpening(rule)}
                      />
                    </SettingsCollection.Item>
                  )}
                </For>
              </SettingsCollection>

              <div class="grid gap-2" data-settings-exceptions="">
                <SettingsCollection title={t().exceptions} description={t().exceptionsDescription} empty={t().noUpcomingExceptions}>
                  <SettingsCollection.Action>
                    <Button type="button" size="sm" disabled={scheduleBusy()} onClick={() => void openAddException()}>
                      <i class="ti ti-plus" aria-hidden="true" /> {t().newException}
                    </Button>
                  </SettingsCollection.Action>
                  <For each={upcomingOverrides()}>{(entry) => <ExceptionItem entry={entry} />}</For>
                </SettingsCollection>
                <Show when={pastOverrides().length > 0}>
                  <Disclosure surface="plain" icon="ti ti-history" summary={t().pastExceptions({ count: pastOverrides().length })}>
                    <SettingsCollection title={t().pastExceptionsTitle}>
                      <For each={pastOverrides()}>{(entry) => <ExceptionItem entry={entry} />}</For>
                    </SettingsCollection>
                  </Disclosure>
                </Show>
              </div>

              <SettingsGroup title={t().shifts} description={t().shiftsDescription}>
                <SettingsGroup.Action>
                  <Button type="button" size="sm" disabled={scheduleBusy()} onClick={() => void openCreateShift()}>
                    <i class="ti ti-plus" aria-hidden="true" /> {t().newShift}
                  </Button>
                </SettingsGroup.Action>
                <Show
                  when={shiftsByWeekday().length > 0}
                  fallback={<Placeholder variant="compact" align="left" description={<>{t().noShifts}</>} />}
                >
                  <div class="grid gap-4" data-settings-shifts="">
                    <For each={shiftsByWeekday()}>
                      {(group) => (
                        <SettingsCollection title={weekday(group.weekday)}>
                          <For each={group.templates}>
                            {(shift) => (
                              <SettingsCollection.Item
                                title={shift.title}
                                description={`${shift.startTime}–${shift.endTime} · ${t().target({ min: shift.minPeople, max: shift.maxPeople })}`}
                                icon={<i class={shift.active ? "ti ti-users" : "ti ti-player-pause"} aria-hidden="true" />}
                              >
                                <Show when={!shift.active}>
                                  <SettingsCollection.Item.Status>
                                    <Tag size="sm">{t().paused}</Tag>
                                  </SettingsCollection.Item.Status>
                                </Show>
                                <RowActions
                                  row={`shift:${shift.id}`}
                                  editLabel={t().editShift}
                                  deleteLabel={t().deleteShift}
                                  onEdit={() => void openEditShift(shift)}
                                  onDelete={() => void confirmDeleteShift(shift)}
                                >
                                  <Tooltip.Anchor content={shift.active ? t().pauseShift : t().resumeShift}>
                                    <Switch
                                      aria-label={t().shiftActiveLabel({ title: shift.title })}
                                      value={shiftSwitchValue(shift)}
                                      disabled={scheduleBusy()}
                                      onValueChange={(active) => void setShiftActive(shift, active)}
                                    />
                                  </Tooltip.Anchor>
                                </RowActions>
                              </SettingsCollection.Item>
                            )}
                          </For>
                        </SettingsCollection>
                      )}
                    </For>
                  </div>
                </Show>
              </SettingsGroup>
            </div>
          </SettingsModal.Tab>
        </SettingsModal.Group>

        <SettingsModal.Group title={t().lifecycle}>
          <SettingsModal.Tab
            id="danger"
            title={t().dangerZone}
            icon="ti ti-alert-triangle"
            description={t().dangerZoneDescription}
            tone="danger"
          >
            <SettingsGroup title={t().deleteVenue} description={t().deleteVenueDescription}>
              <SettingsGroup.Action>
                <VenueDangerZone venue={currentVenue()} onPendingChange={setDangerPending} />
              </SettingsGroup.Action>
            </SettingsGroup>
          </SettingsModal.Tab>
        </SettingsModal.Group>
      </SettingsModal>
    </div>
  );
}
