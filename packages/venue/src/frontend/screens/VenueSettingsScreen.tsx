import { openAccessDialog, principalLabel, type ResourceApiKey, ResourceApiKeySection } from "@k2b/cloud/access/ui";
import type { AccessEntry, PermissionLevel, Principal } from "@k2b/cloud/contracts";
import V2WorkspaceNavigation from "@k2b/cloud/ssr/V2WorkspaceNavigation";
import { navigateTo } from "@k2b/ssr/nav";
import { dates } from "@k2b/stdlib";
import { ColorInput, DEFAULT_ICON_OPTIONS, dialogCore, ImageInput, panelDialogOptions, useLocale } from "@k2b/ui";
import {
  Band,
  Bar,
  Button,
  Canvas,
  Check,
  Choice,
  Dialog,
  Empty,
  Field,
  Input,
  List,
  Menu,
  Nav,
  Notice,
  Pane,
  Path,
  Row,
  Section,
  Select,
  Tabs,
  Text,
  useToast,
  Workspace,
} from "@k2b/ui/v2";
import { createMemo, createSignal, For, type JSX, onCleanup, Show } from "solid-js";
import { apiClient } from "../../api/client";
import type { DateOverride, OpeningRule, ShiftTemplate, Venue, VenueDashboard } from "../../contracts";
import { formatDateKey } from "../../time-format";
import { ExceptionDialog, OpeningRuleDialog, ShiftTemplateDialog } from "../_components/venue-workspace/schedule";
import { bannerTransform, readError, sortOpeningRules, sortOverrides, sortShiftTemplates } from "../_components/venue-workspace/utils";
import { venueSlugError } from "../venue-slug";
import { PublicLinkDialog } from "./LinkDialogs";
import { useVenueWords } from "./messages";
import { iconName } from "./VenueOverviewScreen";
import type { VenueSettingsTab } from "./venue-nav";
import { venueNav, venueSettingsHref, venueViewHref } from "./venue-nav";

export type VenueSettingsContext = Pick<VenueDashboard, "venue" | "openingRules" | "overrides" | "templates"> & {
  accessEntries: AccessEntry[];
  apiKeys: ResourceApiKey[];
};

export type VenueSettingsProps = {
  /** The venue's settings as the server read them; the page reads them again after every change. */
  initial: VenueSettingsContext;
  dashboard: Pick<VenueDashboard, "venue" | "myShiftCount" | "feedback">;
  tab: VenueSettingsTab;
};

/** What the typed API client answers: enough to tell success and read the error. */
type Answer = { ok: boolean; status: number; json: () => Promise<unknown> };

const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;
const TABS: readonly VenueSettingsTab[] = ["general", "access", "schedule", "danger"];

/** Every IANA time zone this runtime knows, plus the venue's own when the list lacks it. */
const timeZones = (current: string) => {
  let zones: string[] = [];
  try {
    zones = Intl.supportedValuesOf("timeZone");
  } catch {
    zones = [];
  }
  return [...new Set([current, ...zones])].sort().map((zone) => ({ value: zone, label: zone.replaceAll("_", " ") }));
};

/**
 * The settings of one venue as a page of its own, for admins: what the venue is and shows (general), who works with
 * it (access, API keys), when it opens and which shifts it plans (schedule), and deleting it. Each area is a tab in
 * the address; every change reads the settings again, and a failed read blocks the next change until it worked.
 */
export default function VenueSettingsScreen(props: VenueSettingsProps) {
  const words = useVenueWords();
  const { t } = words;
  const locale = useLocale();
  const toast = useToast();
  const [settings, setSettings] = createSignal(props.initial);
  const [reading, setReading] = createSignal(false);
  const [readFailed, setReadFailed] = createSignal(false);
  const [busy, setBusy] = createSignal<string | null>(null);
  const [linking, setLinking] = createSignal(false);
  const venue = () => settings().venue;
  const owner = new AbortController();
  onCleanup(() => owner.abort());
  const blocked = () => reading() || readFailed() || busy() !== null;

  /** Reads the settings again after a change; a failure says so and keeps further changes back. */
  const reread = async (success?: string) => {
    setReading(true);
    try {
      const response = await apiClient.venues[":id"]["settings-context"].$get(
        { param: { id: venue().id } },
        { init: { signal: owner.signal } },
      );
      if (!response.ok) throw new Error(await readError(response, t().refreshSettingsFailed));
      setSettings(await response.json());
      setReadFailed(false);
      if (success) toast(success, { status: "ok" });
    } catch {
      if (!owner.signal.aborted) setReadFailed(true);
    } finally {
      setReading(false);
    }
  };
  /** Runs one write at a time with `key` naming the row that shows progress; errors become a toast. */
  const write = async (key: string, run: () => Promise<void>, success: string) => {
    if (blocked()) {
      toast(t().waitForSettings, { status: "bad" });
      return;
    }
    setBusy(key);
    try {
      await run();
      setBusy(null);
      await reread(success);
    } catch (error) {
      setBusy(null);
      if (!owner.signal.aborted) toast(error instanceof Error ? error.message : String(error), { status: "bad" });
    }
  };
  // k2b-ui gap: v2 has no time input yet; the opening, exception and shift dialogs keep their v1 time pickers.
  const openSaving = async (
    render: (close: (saved: boolean) => void, guard: (handler: () => void) => void) => JSX.Element,
    success: () => string,
  ) => {
    if (blocked()) {
      toast(t().waitForSettings, { status: "bad" });
      return;
    }
    const saved = await dialogCore.open<boolean>((close, context) => render(close, context.setDismissHandler), panelDialogOptions);
    if (saved) await reread(success());
  };
  const submitter =
    <V,>(request: (value: V) => Promise<Answer>, failure: string) =>
    async (value: V): Promise<string | null> => {
      const response = await request(value);
      return response.ok ? null : await readError(response, failure);
    };

  const tabs = () =>
    TABS.map((id) => ({
      label: { general: t().general, access: t().access, schedule: t().schedule, danger: t().dangerZone }[id],
      icon: { general: "id", access: "shield", schedule: "calendar-time", danger: "alert-triangle" }[id],
      href: venueSettingsHref(venue().id, id),
      current: props.tab === id,
    }));
  const nav = () => venueNav(words, { ...props.dashboard, venue: venue() }, "settings", () => setLinking(true));

  return (
    <>
      <V2WorkspaceNavigation label={venue().name} groups={nav().groups} foot={nav().foot} />
      <Workspace
        sidebar={<Nav title={t().appName} icon={iconName(venue().icon)} groups={nav().groups} foot={nav().foot} />}
        head={
          <Bar
            start={
              <Path
                label={t().venueSettings}
                items={[{ label: venue().name, href: venueViewHref(venue().id, "shifts") }, { label: t().venueSettings }]}
              />
            }
          />
        }
      >
        <Pane
          label={`${t().venueSettings} · ${venue().name}`}
          head={<Tabs label={words.words().settingsTabs} items={tabs()} />}
          scrollKey={`venue-settings-${props.tab}`}
        >
          <Show when={readFailed()}>
            <Notice
              tone="bad"
              icon="alert-circle"
              title={t().settingsRefreshTitle}
              actions={[{ label: t().retry, icon: "refresh", onClick: () => void reread() }]}
            >
              {t().savedSettingsRefreshFailed}
            </Notice>
          </Show>
          <Show when={props.tab === "general"}>
            <GeneralForm venue={venue()} blocked={blocked()} onSaved={(success) => reread(success)} />
          </Show>
          <Show when={props.tab === "access"}>
            <AccessArea settings={settings()} blocked={blocked()} reread={reread} write={write} />
          </Show>
          <Show when={props.tab === "schedule"}>
            <ScheduleArea
              settings={settings()}
              busy={busy()}
              openSaving={openSaving}
              submitter={submitter}
              write={write}
              locale={locale()}
            />
          </Show>
          <Show when={props.tab === "danger"}>
            <DangerArea venue={venue()} />
          </Show>
        </Pane>
      </Workspace>
      <PublicLinkDialog open={linking()} venueId={venue().id} publicEnabled={venue().publicEnabled} close={() => setLinking(false)} />
    </>
  );
}

/** What the venue is and shows; one Save at the end, a taken address shows at its field. */
function GeneralForm(props: { venue: Venue; blocked: boolean; onSaved: (success: string) => Promise<void> }) {
  const { t, words } = useVenueWords();
  const toast = useToast();
  const initial = () => ({
    name: props.venue.name,
    icon: props.venue.icon || "ti ti-building-carousel",
    slug: props.venue.slug,
    description: props.venue.description ?? "",
    openMode: props.venue.openMode,
    signupMode: props.venue.signupMode,
    timezone: props.venue.timezone,
    publicEnabled: props.venue.publicEnabled,
    feedbackEnabled: props.venue.feedbackEnabled,
    accentColor: props.venue.accentColor,
    logoBase64: props.venue.logoBase64,
    bannerBase64: props.venue.bannerBase64,
  });
  type Draft = ReturnType<typeof initial>;
  const [saved, setSaved] = createSignal(initial());
  const [draft, setDraft] = createSignal(initial());
  const [slugTaken, setSlugTaken] = createSignal(false);
  const [saving, setSaving] = createSignal(false);
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    if (key === "slug") setSlugTaken(false);
    setDraft({ ...draft(), [key]: value });
  };
  const changed = createMemo(() => (Object.keys(draft()) as (keyof Draft)[]).some((key) => draft()[key] !== saved()[key]));
  const nameError = () => (draft().name.trim() ? undefined : t().nameRequired);
  const slugError = () => venueSlugError(draft().slug, t()) ?? (slugTaken() ? t().slugTaken : undefined);
  const zones = createMemo(() => timeZones(props.venue.timezone));
  const save = async () => {
    if (props.blocked || saving() || nameError() || slugError()) return;
    setSaving(true);
    try {
      const value = draft();
      const response = await apiClient.venues[":id"].$patch({
        param: { id: props.venue.id },
        json: { ...value, name: value.name.trim(), description: value.description.trim() || null },
      });
      if (response.status === 409) return setSlugTaken(true);
      if (!response.ok) throw new Error(await readError(response, t().saveVenueFailed));
      setSaved(value);
      await props.onSaved(t().venueSaved);
    } catch (error) {
      toast(error instanceof Error ? error.message : t().saveVenueFailed, { status: "bad" });
    } finally {
      setSaving(false);
    }
  };
  return (
    <>
      <Section icon="id" title={t().identity} summary={t().identityDescription}>
        <Band>
          <Field name="name" label={t().name} hint={t().nameDescription} required error={nameError()}>
            <Input value={draft().name} onInput={(value) => set("name", value)} />
          </Field>
          <Field name="slug" label={t().slug} hint={t().slugDescription} error={slugError()}>
            <Input value={draft().slug} onInput={(value) => set("slug", value.trim().toLowerCase())} />
          </Field>
          <Field name="description" label={t().description} hint={t().publicDescriptionDescription} optional={words().optional}>
            <Input multiline value={draft().description} onInput={(value) => set("description", value)} />
          </Field>
        </Band>
      </Section>
      <Section icon="calendar-time" title={t().scheduleRules} summary={t().scheduleRulesDescription}>
        <Band>
          <Field name="openMode" label={t().publicOpeningLogic} hint={t().publicOpeningLogicDescription}>
            <Choice
              name="openMode"
              options={[
                { value: "regular", label: t().regular },
                { value: "staffed", label: t().staffedMode },
                { value: "combined", label: t().both },
              ]}
              value={draft().openMode}
              onChange={(value) => set("openMode", value === "regular" || value === "staffed" ? value : "combined")}
            />
          </Field>
          <Field name="signupMode" label={t().signupMode} hint={t().signupModeDescription}>
            <Choice
              name="signupMode"
              options={[
                { value: "templates", label: t().signupModeShifts },
                { value: "free", label: t().freeTime },
                { value: "both", label: t().both },
              ]}
              value={draft().signupMode}
              onChange={(value) => set("signupMode", value === "templates" || value === "free" ? value : "both")}
            />
          </Field>
          <Field name="timezone" label={t().timezone} hint={t().timezoneDescription}>
            <Select options={zones()} value={draft().timezone} onChange={(value) => set("timezone", value)} />
          </Field>
        </Band>
      </Section>
      <Section icon="world" title={t().publicPage} summary={t().publicPageSettingDescription}>
        <Band>
          <Check switch label={t().publicPageOn} checked={draft().publicEnabled} onChange={(value) => set("publicEnabled", value)} />
          <Text type="meta" muted>
            {t().publicPageOnDescription}
          </Text>
          <Check
            switch
            label={t().feedbackActivated}
            checked={draft().feedbackEnabled}
            onChange={(value) => set("feedbackEnabled", value)}
          />
          <Text type="meta" muted>
            {t().feedbackActivatedDescription}
          </Text>
        </Band>
      </Section>
      <Section icon="palette" title={t().publicBranding} summary={t().publicBrandingDescription}>
        <Band>
          {/* k2b-ui gap: no icon picker in v2; a selection of the curated icons by name. */}
          <Field name="icon" label={t().icon} hint={t().iconDescription}>
            <Select
              options={DEFAULT_ICON_OPTIONS.map((option) => ({ value: option.value, label: option.label }))}
              value={draft().icon}
              onChange={(value) => set("icon", value)}
            />
          </Field>
        </Band>
        {/* k2b-ui gap: no colour or image input in v2; the v1 inputs keep their behaviour in a canvas. */}
        <Canvas label={t().publicBranding}>
          <ColorInput
            aria-label={t().themeColor}
            label={t().themeColor}
            value={() => draft().accentColor}
            onValueChange={(value) => set("accentColor", value)}
          />
          <ImageInput
            aria-label={t().logo}
            label={t().logo}
            value={() => draft().logoBase64}
            onValueChange={(value) => set("logoBase64", value)}
            variant="small"
          />
          <ImageInput
            aria-label={t().bannerImage}
            label={t().bannerImage}
            value={() => draft().bannerBase64}
            onValueChange={(value) => set("bannerBase64", value)}
            transform={bannerTransform}
          />
        </Canvas>
      </Section>
      <Bar
        end={
          <>
            <Button disabled={!changed() || saving()} onClick={() => setDraft(saved())}>
              {words().discard}
            </Button>
            <Button variant="primary" icon="check" busy={saving()} disabled={!changed() || props.blocked} onClick={() => void save()}>
              {words().save}
            </Button>
          </>
        }
      />
    </>
  );
}

/** Who works with the venue (people and groups through the access dialog) and the integrations' API keys. */
function AccessArea(props: {
  settings: VenueSettingsContext;
  blocked: boolean;
  reread: (success?: string) => Promise<void>;
  write: (key: string, run: () => Promise<void>, success: string) => Promise<void>;
}) {
  const { t } = useVenueWords();
  const locale = useLocale();
  const toast = useToast();
  const [editing, setEditing] = createSignal(false);
  const venueId = () => props.settings.venue.id;
  const people = () => props.settings.accessEntries.filter((entry) => entry.serviceAccountKind !== "resource_bound");
  const level = (permission: PermissionLevel) => (permission === "admin" ? t().admin : permission === "write" ? t().staff : t().read);
  const levels = [
    { level: "read" as const, label: t().read },
    { level: "write" as const, label: t().staff },
    { level: "admin" as const, label: t().admin },
  ];
  const edit = async () => {
    if (props.blocked || editing()) return;
    setEditing(true);
    let wrote = false;
    const call = async (request: Promise<Answer>, failure: string) => {
      const response = await request;
      if (!response.ok) throw new Error(await readError(response, failure));
      wrote = true;
    };
    try {
      // k2b-ui gap: the access dialog of the platform is not on v2 yet; it keeps its behaviour over this page.
      await openAccessDialog({
        target: { type: "venue.venue", id: venueId() },
        resourceName: props.settings.venue.name,
        subtitle: t().accessDialogSubtitle,
        initialEntries: people(),
        grantAccess: async (principal: Principal, permission) => {
          const response = await apiClient.venues[":id"].access.$post({ param: { id: venueId() }, json: { principal, permission } });
          if (!response.ok) throw new Error(await readError(response, t().grantAccessFailed));
          wrote = true;
          return response.json();
        },
        updateAccess: async (accessId, permission) => {
          await call(
            apiClient.venues[":id"].access[":accessId"].$patch({ param: { id: venueId(), accessId }, json: { permission } }),
            t().updateAccessFailed,
          );
        },
        revokeAccess: async (accessId) => {
          await call(apiClient.venues[":id"].access[":accessId"].$delete({ param: { id: venueId(), accessId } }), t().revokeAccessFailed);
        },
        allowedLevels: levels,
      });
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), { status: "bad" });
    } finally {
      setEditing(false);
    }
    if (wrote) await props.reread(t().accessUpdated);
  };
  return (
    <>
      <Section
        icon="users"
        title={t().peopleAndGroups}
        count={people().length}
        summary={t().peopleAndGroupsDescription}
        actions={[{ label: t().editAccess, icon: "lock-access", disabled: props.blocked || editing(), onClick: () => void edit() }]}
      >
        <Show when={people().length > 0} fallback={<Empty icon="users" text={t().peopleAndGroupsDescription} />}>
          <List label={t().peopleAndGroups}>
            <For each={people()}>
              {(entry) => (
                <Row
                  avatar={{ name: principalLabel(entry, locale()) }}
                  lines={[principalLabel(entry, locale()), level(entry.permission)]}
                />
              )}
            </For>
          </List>
        </Show>
      </Section>
      <ResourceApiKeySection
        title={t().apiKeys}
        description={t().apiKeysDescription}
        initialKeys={props.settings.apiKeys}
        createKey={async (input) => {
          const response = await apiClient.venues[":id"]["api-keys"].$post({ param: { id: venueId() }, json: input });
          if (!response.ok) throw new Error(await readError(response, t().createApiKeyFailed));
          const created = (await response.json()) as { credential: ResourceApiKey; token: string };
          void props.reread(t().apiKeyCreated);
          return created;
        }}
        revokeKey={async (credentialId) => {
          const response = await apiClient.venues[":id"]["api-keys"][":credentialId"].$delete({ param: { id: venueId(), credentialId } });
          if (!response.ok) throw new Error(await readError(response, t().revokeApiKeyFailed));
          void props.reread(t().apiKeyRevoked);
        }}
      />
    </>
  );
}

/** When the venue opens (regular hours, exceptions) and which shifts it plans; each entry has its deeds behind "…". */
function ScheduleArea(props: {
  settings: VenueSettingsContext;
  busy: string | null;
  locale: string;
  openSaving: (
    render: (close: (saved: boolean) => void, guard: (handler: () => void) => void) => JSX.Element,
    success: () => string,
  ) => Promise<unknown>;
  submitter: <V>(request: (value: V) => Promise<Answer>, failure: string) => (value: V) => Promise<string | null>;
  write: (key: string, run: () => Promise<void>, success: string) => Promise<void>;
}) {
  const { t } = useVenueWords();
  const venue = () => props.settings.venue;
  const id = () => venue().id;
  const weekday = (value: number) =>
    new Intl.DateTimeFormat(props.locale, { weekday: "long", timeZone: "UTC" }).format(new Date(Date.UTC(2026, 0, 4 + value)));
  const today = () => dates.formatDateKey(new Date(), { timeZone: venue().timezone });
  const day = (date: string) => formatDateKey(date, props.locale, { weekday: "short", day: "numeric", month: "numeric", year: "numeric" });
  const upcoming = () => sortOverrides(props.settings.overrides).filter((entry) => entry.date >= today());
  const past = () =>
    sortOverrides(props.settings.overrides)
      .filter((entry) => entry.date < today())
      .reverse();
  const weekly = () => sortShiftTemplates(props.settings.templates.filter((template) => template.date === null));
  const oneOff = () =>
    props.settings.templates
      .filter((template): template is ShiftTemplate & { date: string } => template.date !== null && template.date >= today())
      .sort((a, b) => a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime));
  const describe = (entry: DateOverride) =>
    [
      entry.kind === "open" && entry.startTime && entry.endTime
        ? t().specialOpening({ window: `${entry.startTime}–${entry.endTime}` })
        : t().closed,
      entry.note,
    ]
      .filter(Boolean)
      .join(" · ");
  const del = (path: () => Promise<Answer>, failure: string) => async () => {
    const response = await path();
    if (!response.ok) throw new Error(await readError(response, failure));
  };
  const confirmThen = async (question: { title: string; description: string }, key: string, run: () => Promise<void>, success: string) => {
    if (await Dialog.confirm({ ...question, confirm: t().delete, cancel: t().cancel })) await props.write(key, run, success);
  };

  const addOpening = () =>
    props.openSaving(
      (close, guard) => (
        <OpeningRuleDialog
          close={close}
          guardDismiss={guard}
          submit={props.submitter(
            (json) => apiClient.venues[":id"]["opening-rules"].$post({ param: { id: id() }, json }),
            t().addOpeningFailed,
          )}
        />
      ),
      () => t().openingAdded,
    );
  const editOpening = (rule: OpeningRule) =>
    props.openSaving(
      (close, guard) => (
        <OpeningRuleDialog
          close={close}
          guardDismiss={guard}
          initial={{ ...rule }}
          submit={props.submitter(
            (json) => apiClient.venues[":id"]["opening-rules"][":resourceId"].$patch({ param: { id: id(), resourceId: rule.id }, json }),
            t().updateOpeningFailed,
          )}
        />
      ),
      () => t().openingUpdated,
    );
  const addException = () =>
    props.openSaving(
      (close, guard) => (
        <ExceptionDialog
          close={close}
          guardDismiss={guard}
          timeZone={venue().timezone}
          today={today()}
          takenDates={props.settings.overrides.map((entry) => entry.date)}
          submit={props.submitter((json) => apiClient.venues[":id"].overrides.$post({ param: { id: id() }, json }), t().addExceptionFailed)}
        />
      ),
      () => t().exceptionAdded,
    );
  const editException = (entry: DateOverride) =>
    props.openSaving(
      (close, guard) => (
        <ExceptionDialog
          close={close}
          guardDismiss={guard}
          timeZone={venue().timezone}
          initial={{ ...entry }}
          takenDates={props.settings.overrides.filter((other) => other.id !== entry.id).map((other) => other.date)}
          submit={async (json) => {
            const response = await apiClient.venues[":id"].overrides[":resourceId"].$patch({
              param: { id: id(), resourceId: entry.id },
              json,
            });
            if (response.status === 409) return t().exceptionDateTaken;
            return response.ok ? null : await readError(response, t().updateExceptionFailed);
          }}
        />
      ),
      () => t().exceptionUpdated,
    );
  const addShift = () => {
    let count = 1;
    return props.openSaving(
      (close, guard) => (
        <ShiftTemplateDialog
          close={close}
          guardDismiss={guard}
          timeZone={venue().timezone}
          today={today()}
          submit={(templates) => {
            count = templates.length;
            return props.submitter(
              (json: { templates: typeof templates }) => apiClient.venues[":id"].templates.batch.$post({ param: { id: id() }, json }),
              t().addShiftFailed,
            )({
              templates,
            });
          }}
        />
      ),
      () => (count > 1 ? t().shiftsAdded({ count }) : t().shiftAdded),
    );
  };
  const editShift = (shift: ShiftTemplate) =>
    props.openSaving(
      (close, guard) => (
        <ShiftTemplateDialog
          close={close}
          guardDismiss={guard}
          timeZone={venue().timezone}
          today={today()}
          initial={{ ...shift }}
          submit={([json]) =>
            json
              ? props.submitter(
                  (input: typeof json) =>
                    apiClient.venues[":id"].templates[":resourceId"].$patch({ param: { id: id(), resourceId: shift.id }, json: input }),
                  t().updateShiftFailed,
                )(json)
              : Promise.resolve(t().updateShiftFailed)
          }
        />
      ),
      () => t().shiftUpdated,
    );
  const setActive = (shift: ShiftTemplate, active: boolean) => {
    const { id: resourceId, venueId: _venueId, createdAt: _createdAt, updatedAt: _updatedAt, ...input } = shift;
    return props.write(
      `pause:${resourceId}`,
      del(
        () => apiClient.venues[":id"].templates[":resourceId"].$patch({ param: { id: id(), resourceId }, json: { ...input, active } }),
        active ? t().resumeShiftFailed : t().pauseShiftFailed,
      ),
      active ? t().shiftResumed : t().shiftPaused,
    );
  };
  const shiftRow = (shift: ShiftTemplate) => (
    <Row
      icon={shift.active ? "calendar-event" : "player-pause"}
      color={shift.active ? venue().accentColor : undefined}
      lines={[
        shift.title,
        [
          shift.date ? day(shift.date) : weekday(shift.weekday),
          `${shift.startTime}–${shift.endTime}`,
          shift.maxPeople && shift.maxPeople > shift.minPeople ? `${shift.minPeople}–${shift.maxPeople}` : String(shift.minPeople),
          shift.active ? "" : t().paused,
        ]
          .filter(Boolean)
          .join(" · "),
      ]}
      end={
        <Menu
          label={`${t().editShift}: ${shift.title}`}
          disabled={props.busy !== null}
          items={[
            { label: t().editShift, icon: "pencil", onClick: () => void editShift(shift) },
            {
              label: shift.active ? t().pauseShift : t().resumeShift,
              icon: shift.active ? "player-pause" : "player-play",
              onClick: () => void setActive(shift, !shift.active),
            },
            {
              label: t().deleteShift,
              icon: "trash",
              danger: true,
              onClick: () =>
                void confirmThen(
                  { title: t().deleteShift, description: t().deleteShiftQuestion({ title: shift.title }) },
                  `shift:${shift.id}`,
                  del(
                    () => apiClient.venues[":id"].templates[":resourceId"].$delete({ param: { id: id(), resourceId: shift.id } }),
                    t().deleteShiftFailed,
                  ),
                  t().shiftDeleted,
                ),
            },
          ]}
        />
      }
    />
  );
  const exceptionRow = (entry: DateOverride) => (
    <Row
      icon={entry.kind === "open" ? "calendar-plus" : "calendar-off"}
      lines={[day(entry.date), describe(entry)]}
      end={
        <Menu
          label={`${t().editException}: ${day(entry.date)}`}
          disabled={props.busy !== null}
          items={[
            { label: t().editException, icon: "pencil", onClick: () => void editException(entry) },
            {
              label: t().deleteException,
              icon: "trash",
              danger: true,
              onClick: () =>
                void confirmThen(
                  { title: t().deleteException, description: t().deleteExceptionQuestion({ date: day(entry.date) }) },
                  `exception:${entry.id}`,
                  del(
                    () => apiClient.venues[":id"].overrides[":resourceId"].$delete({ param: { id: id(), resourceId: entry.id } }),
                    t().deleteExceptionFailed,
                  ),
                  t().exceptionDeleted,
                ),
            },
          ]}
        />
      }
    />
  );
  return (
    <>
      <Section
        icon="clock"
        title={t().regularHours}
        count={props.settings.openingRules.length}
        summary={t().regularHoursDescription}
        actions={[{ label: t().newHours, icon: "plus", onClick: () => void addOpening() }]}
      >
        <Show when={props.settings.openingRules.length > 0} fallback={<Empty icon="clock" text={t().noRegularHours} />}>
          <List label={t().regularHours}>
            <For each={sortOpeningRules(props.settings.openingRules)}>
              {(rule) => (
                <Row
                  icon="clock"
                  lines={[weekday(rule.weekday), `${rule.startTime}–${rule.endTime}${rule.note ? ` · ${rule.note}` : ""}`]}
                  end={
                    <Menu
                      label={`${t().editOpening}: ${weekday(rule.weekday)}`}
                      disabled={props.busy !== null}
                      items={[
                        { label: t().editOpening, icon: "pencil", onClick: () => void editOpening(rule) },
                        {
                          label: t().deleteOpening,
                          icon: "trash",
                          danger: true,
                          onClick: () =>
                            void confirmThen(
                              {
                                title: t().deleteOpening,
                                description: t().deleteOpeningQuestion({
                                  label: `${weekday(rule.weekday)} ${rule.startTime}–${rule.endTime}`,
                                }),
                              },
                              `opening:${rule.id}`,
                              del(
                                () =>
                                  apiClient.venues[":id"]["opening-rules"][":resourceId"].$delete({
                                    param: { id: id(), resourceId: rule.id },
                                  }),
                                t().deleteOpeningFailed,
                              ),
                              t().openingDeleted,
                            ),
                        },
                      ]}
                    />
                  }
                />
              )}
            </For>
          </List>
        </Show>
      </Section>
      <Section
        icon="calendar-exclamation"
        title={t().exceptions}
        count={upcoming().length}
        summary={t().exceptionsDescription}
        actions={[{ label: t().newException, icon: "plus", onClick: () => void addException() }]}
      >
        <Show when={upcoming().length > 0} fallback={<Empty icon="calendar-check" text={t().noUpcomingExceptions} />}>
          <List label={t().exceptions}>
            <For each={upcoming()}>{exceptionRow}</For>
          </List>
        </Show>
      </Section>
      <Show when={past().length > 0}>
        <Section icon="history" title={t().pastExceptionsTitle} count={past().length}>
          <List label={t().pastExceptionsTitle}>
            <For each={past()}>{exceptionRow}</For>
          </List>
        </Section>
      </Show>
      <Section
        icon="users"
        title={t().shifts}
        count={weekly().length}
        summary={t().shiftsDescription}
        actions={[{ label: t().newShift, icon: "plus", onClick: () => void addShift() }]}
      >
        <Show when={weekly().length > 0} fallback={<Empty icon="calendar-off" text={t().noShifts} />}>
          <List label={t().shifts}>
            <For each={WEEKDAY_ORDER.flatMap((weekdayValue) => weekly().filter((shift) => shift.weekday === weekdayValue))}>{shiftRow}</For>
          </List>
        </Show>
      </Section>
      <Show when={oneOff().length > 0}>
        <Section icon="calendar-star" title={t().oneOffShifts} count={oneOff().length}>
          <List label={t().oneOffShifts}>
            <For each={oneOff()}>{shiftRow}</For>
          </List>
        </Section>
      </Show>
    </>
  );
}

/** Deleting the venue removes shifts, sign-ups, feedback and the public page for good, so it takes the typed name. */
function DangerArea(props: { venue: Venue }) {
  const { t, words } = useVenueWords();
  const [open, setOpen] = createSignal(false);
  const [typed, setTyped] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  // A name with a line break cannot be typed into one line; the address stands in for it.
  const phrase = () => (/[\r\n\t]/.test(props.venue.name) ? props.venue.slug : props.venue.name);
  const remove = async () => {
    if (typed() !== phrase() || busy()) return;
    setBusy(true);
    setError(null);
    try {
      const response = await apiClient.venues[":id"].$delete({ param: { id: props.venue.id } });
      if (!response.ok) throw new Error(await readError(response, t().deleteVenueFailed));
      navigateTo("/app/venue");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t().deleteVenueFailed);
      setBusy(false);
    }
  };
  return (
    <Section icon="alert-triangle" title={t().dangerZone} summary={t().dangerZoneDescription}>
      <List label={t().dangerZone}>
        <Row
          icon="trash"
          lines={[t().deleteVenue, t().deleteVenueDescription]}
          action={{ label: t().deleteVenue, icon: "trash", onClick: () => setOpen(true) }}
        />
      </List>
      <Dialog
        title={t().deleteVenue}
        open={open()}
        onOpenChange={(next) => {
          if (!next && !busy()) {
            setOpen(false);
            setTyped("");
          }
        }}
        foot={
          <>
            <Button disabled={busy()} onClick={() => setOpen(false)}>
              {t().cancel}
            </Button>
            <Button variant="primary" icon="trash" busy={busy()} disabled={typed() !== phrase()} onClick={() => void remove()}>
              {t().deleteVenue}
            </Button>
          </>
        }
      >
        <Show when={error()}>
          {(message) => (
            <Notice tone="bad" icon="alert-circle">
              {message()}
            </Notice>
          )}
        </Show>
        <Text>{t().deleteVenueQuestion({ name: props.venue.name })}</Text>
        <Field name="confirm-name" label={words().typeToConfirm({ phrase: phrase() })}>
          <Input value={typed()} onInput={setTyped} />
        </Field>
      </Dialog>
    </Section>
  );
}
