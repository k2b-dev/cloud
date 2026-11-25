import { navigateTo } from "@k2b/ssr/nav";
import { mutation as mutations } from "@k2b/stdlib/solid";
import { useLocale } from "@k2b/ui";
import { Bar, Button, Choice, confirm, Facts, Field, Input, Notice, Section, Select, Text, useToast } from "@k2b/ui/v2";
import { createEffect, createSignal, onCleanup, Show } from "solid-js";
import { apiClient } from "@/api/client";
import type { SpaceDetail } from "@/contracts";
import { spaceColorOptions } from "../../../_components/space-colors";
import { useSpaceMessages } from "../../messages";
import {
  type EventsDaysAhead,
  readWidgetSettings,
  type SpaceUserSettings,
  type ViewType,
  type WidgetSettings,
  writeSpaceSettings,
  writeWidgetSettings,
} from "../settings/SpaceSettingsStore";
import { readErrorMessage } from "./utils";

/** Name, description and colour of the Space; nothing applies before "Save", and the bar says how much changed. */
export function GeneralSection(props: { space: SpaceDetail; onDirtyChange: (dirty: boolean) => void }) {
  const m = useSpaceMessages();
  const locale = useLocale();
  const toast = useToast();
  const [base, setBase] = createSignal({ name: props.space.name, description: props.space.description ?? "", color: props.space.color });
  const [name, setName] = createSignal(base().name);
  const [description, setDescription] = createSignal(base().description);
  const [color, setColor] = createSignal(base().color);
  const changes = () => Number(name() !== base().name) + Number(description() !== base().description) + Number(color() !== base().color);
  createEffect(() => props.onDirtyChange(changes() > 0));
  onCleanup(() => props.onDirtyChange(false));
  type Intent = { name: string; description: string; color: string };
  const save = mutations.create<void, Intent, Intent>({
    onBefore: (intent) => intent,
    mutation: async (intent) => {
      const res = await apiClient[":id"].$patch({
        param: { id: props.space.id },
        json: { name: intent.name, description: intent.description || null, color: intent.color },
      });
      if (!res.ok) throw new Error(await readErrorMessage(res, m.saveSpaceSettingsFailed));
    },
    onSuccess: (_result, intent) => {
      if (intent) setBase(intent);
      toast(m.spaceSettingsSaved, { status: "ok" });
    },
  });
  const submit = () => {
    if (save.loading() || !name().trim()) return;
    void save.mutate({ name: name().trim(), description: description(), color: color() });
  };
  return (
    <Section icon="id" title={m.identity} summary={m.identityDescription}>
      <Field label={m.name} name="space-name" hint={m.spaceNameDescription} error={!name().trim() ? m.nameRequired : undefined} required>
        <Input
          value={name()}
          placeholder={m.spaceNamePlaceholder}
          onInput={setName}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.isComposing) submit();
          }}
        />
      </Field>
      <Field label={m.description} name="space-description" optional={m.optional}>
        <Input multiline value={description()} onInput={setDescription} />
      </Field>
      <Field label={m.color} name="space-color">
        {/* k2b-ui gap: v2 has no colour input; the Space picks from the named palette (its own colour stays an option). */}
        <Select value={color()} options={spaceColorOptions(locale(), color())} onChange={setColor} />
      </Field>
      <Show when={save.error()}>{(error) => <Notice tone="bad">{error().message}</Notice>}</Show>
      <Bar
        start={<Text type="meta">{changes() > 0 ? m.changesPending({ count: changes() }) : ""}</Text>}
        end={
          <>
            <Button
              disabled={changes() === 0 || save.loading()}
              onClick={() => {
                setName(base().name);
                setDescription(base().description);
                setColor(base().color);
              }}
            >
              {m.discard}
            </Button>
            <Button variant="primary" busy={save.loading()} disabled={changes() === 0 || !name().trim()} onClick={submit}>
              {m.save}
            </Button>
          </>
        }
      />
    </Section>
  );
}

/** This person's own choices in this browser: the view the Space opens with and what the home widgets show. */
export function DefaultsSection(props: { spaceId: string; initialSettings: SpaceUserSettings }) {
  const m = useSpaceMessages();
  const [view, setView] = createSignal<ViewType>(props.initialSettings.view);
  const [widgets, setWidgets] = createSignal<WidgetSettings>(readWidgetSettings());
  const views: { value: ViewType; label: string }[] = [
    { value: "list", label: m.list },
    { value: "table", label: m.table },
    { value: "kanban", label: m.kanban },
    { value: "calendar", label: m.calendar },
  ];
  const updateWidgets = <K extends keyof WidgetSettings>(key: K, value: WidgetSettings[K]) => {
    const next = { ...widgets(), [key]: value };
    setWidgets(next);
    writeWidgetSettings(next);
  };
  return (
    <>
      <Section icon="layout-sidebar" title={m.thisSpace} summary={m.localSettingsDescription}>
        <Field label={m.defaultView} name="default-view" hint={m.defaultViewDescription}>
          <Select
            value={view()}
            options={views}
            onChange={(value) => {
              const next = views.find((entry) => entry.value === value)?.value;
              if (!next) return;
              setView(next);
              // Merge into the stored settings: the board writes folded columns to the same entry.
              writeSpaceSettings(props.spaceId, { view: next });
            }}
          />
        </Field>
      </Section>
      <Section icon="layout-dashboard" title={m.homeWidgets} summary={m.homeWidgetsDescription}>
        <Field label={m.eventRange} name="event-range" hint={m.eventRangeDescription}>
          <Choice
            name="event-range"
            value={String(widgets().eventsDaysAhead)}
            options={[
              { value: "1", label: m.today },
              { value: "3", label: m.threeDays },
              { value: "7", label: m.oneWeek },
              { value: "14", label: m.twoWeeks },
            ]}
            onChange={(value) => {
              const days = ([1, 3, 7, 14] as const).find((entry) => String(entry) === value);
              if (days) updateWidgets("eventsDaysAhead", days satisfies EventsDaysAhead);
            }}
          />
        </Field>
        <Field label={m.taskPriority} name="task-priority" hint={m.taskPriorityDescription}>
          <Select
            value={widgets().tasksMinPriority ?? ""}
            options={[
              { value: "", label: m.all },
              { value: "low", label: m.lowPlus },
              { value: "medium", label: m.mediumPlus },
              { value: "high", label: m.highPlus },
              { value: "urgent", label: m.urgent },
            ]}
            onChange={(value) => {
              const priority = (["low", "medium", "high", "urgent"] as const).find((entry) => entry === value);
              updateWidgets("tasksMinPriority", priority ?? null);
            }}
          />
        </Field>
      </Section>
    </>
  );
}

/** The Space's calendar as an iCal address to copy, a new address for admins, and how calendar apps add it. */
export function CalendarSection(props: { spaceId: string; icalToken: string | null; baseUrl: string; isAdmin: boolean }) {
  const m = useSpaceMessages();
  const toast = useToast();
  const [token, setToken] = createSignal(props.icalToken);
  const regenerate = mutations.create<{ icalToken: string }, void>({
    mutation: async () => {
      const res = await apiClient[":id"]["regenerate-ical-token"].$post({ param: { id: props.spaceId } });
      if (!res.ok) throw new Error(await readErrorMessage(res, m.regenerateTokenFailed));
      return res.json();
    },
    onSuccess: (data) => {
      setToken(data.icalToken);
      toast(m.calendarTokenRegenerated, { status: "ok" });
    },
    onError: (error) => toast(error.message, { status: "bad" }),
  });
  const ask = async () => {
    if (regenerate.loading()) return;
    if (await confirm({ title: m.regenerateToken, description: m.regenerateTokenConfirm, confirm: m.regenerateUrl }))
      void regenerate.mutate();
  };
  const icalUrl = () => (token() ? `${props.baseUrl}/api/spaces/calendar/ical/${token()}.ics` : null);
  return (
    <>
      <Section
        icon="calendar-share"
        title={m.calendarFeed}
        summary={m.calendarFeedDescription}
        actions={
          props.isAdmin && icalUrl()
            ? [{ label: m.regenerateUrl, icon: "refresh", disabled: regenerate.loading(), onClick: () => void ask() }]
            : undefined
        }
      >
        <Show when={icalUrl()} fallback={<Text>{m.noCalendarUrl}</Text>}>
          {(url) => <Facts items={[{ label: m.icalAddress, value: url(), mono: true, copy: url() }]} />}
        </Show>
      </Section>
      <Section icon="apps" title={m.calendarApps} summary={m.calendarAppsDescription}>
        <Facts
          items={[
            { label: "Thunderbird", value: m.thunderbirdInstructions },
            { label: "Google Calendar", value: m.googleCalendarInstructions },
            { label: "Apple Calendar", value: m.appleCalendarInstructions },
            { label: "Outlook", value: m.outlookInstructions },
          ]}
        />
      </Section>
    </>
  );
}

/** Deleting the Space with everything in it, after one question. */
export function DangerZone(props: { spaceId: string; spaceName: string }) {
  const m = useSpaceMessages();
  const toast = useToast();
  const remove = mutations.create<void, void>({
    mutation: async () => {
      const res = await apiClient[":id"].$delete({ param: { id: props.spaceId } });
      if (!res.ok) throw new Error(await readErrorMessage(res, m.deleteSpaceFailed));
    },
    onSuccess: () => {
      toast(m.spaceDeleted, { status: "ok" });
      navigateTo("/app/spaces");
    },
    onError: (error) => toast(error.message, { status: "bad" }),
  });
  const ask = async () => {
    if (remove.loading()) return;
    if (await confirm({ title: m.deleteSpace, description: m.deleteSpaceConfirm({ name: props.spaceName }), confirm: m.deleteSpace }))
      void remove.mutate();
  };
  return (
    <Notice
      tone="bad"
      icon="alert-triangle"
      title={m.deleteSpace}
      actions={[{ label: m.deleteSpace, icon: "trash", disabled: remove.loading(), onClick: () => void ask() }]}
    >
      {m.deleteSpaceDescription}
    </Notice>
  );
}
