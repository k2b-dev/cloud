import { SegmentedControl, SettingsField, SettingsGroup } from "@k2b/ui";
import { createSignal } from "solid-js";
import type { Priority } from "@/contracts";
import { useSpaceMessages } from "../../messages";
import {
  type EventsDaysAhead,
  readAllSettings,
  readWidgetSettings,
  type SpaceUserSettings,
  type ViewType,
  type WidgetSettings,
  writeAllSettings,
  writeWidgetSettings,
} from "../settings/SpaceSettingsStore";

function LocalSettingsForm(props: { spaceId: string; initialSettings: SpaceUserSettings }) {
  const m = useSpaceMessages();
  const [settings, setSettings] = createSignal<SpaceUserSettings>(props.initialSettings);
  const viewOptions: { value: ViewType; label: string; icon: string }[] = [
    { value: "list", label: m.overview, icon: "ti-home" },
    { value: "table", label: m.table, icon: "ti-table" },
    { value: "kanban", label: "Kanban", icon: "ti-layout-kanban" },
    { value: "calendar", label: m.calendar, icon: "ti-calendar" },
  ];

  const updateSetting = <K extends keyof SpaceUserSettings>(key: K, value: SpaceUserSettings[K]) => {
    const newSettings = { ...settings(), [key]: value };
    setSettings(newSettings);

    const allSettings = readAllSettings();
    allSettings.spaces[props.spaceId] = newSettings;
    writeAllSettings(allSettings);
  };

  return (
    <SettingsGroup title={m.thisSpace} description={m.localSettingsDescription}>
      <SettingsField label={m.defaultView} description={m.defaultViewDescription} error={() => undefined}>
        <SegmentedControl
          options={viewOptions.map((o) => ({
            value: o.value,
            label: o.label,
            icon: `ti ${o.icon}`,
          }))}
          value={() => settings().view}
          onValueChange={(v) => updateSetting("view", v)}
        />
      </SettingsField>
    </SettingsGroup>
  );
}

function WidgetSettingsForm() {
  const m = useSpaceMessages();
  const [settings, setSettings] = createSignal<WidgetSettings>(readWidgetSettings());
  const eventDaysOptions = [
    { value: "1" as const, label: m.today },
    { value: "3" as const, label: m.threeDays },
    { value: "7" as const, label: m.oneWeek },
    { value: "14" as const, label: m.twoWeeks },
  ];
  const taskPriorityOptions = [
    { value: "" as const, label: m.all },
    { value: "low" as const, label: m.lowPlus },
    { value: "medium" as const, label: m.mediumPlus },
    { value: "high" as const, label: m.highPlus },
    { value: "urgent" as const, label: m.urgent },
  ];

  const updateSetting = <K extends keyof WidgetSettings>(key: K, value: WidgetSettings[K]) => {
    const newSettings = { ...settings(), [key]: value };
    setSettings(newSettings);
    writeWidgetSettings(newSettings);
  };

  return (
    <SettingsGroup title={m.homeWidgets} description={m.homeWidgetsDescription}>
      <SettingsField label={m.eventRange} description={m.eventRangeDescription} error={() => undefined}>
        <SegmentedControl
          options={eventDaysOptions}
          value={() => String(settings().eventsDaysAhead)}
          onValueChange={(v) => updateSetting("eventsDaysAhead", Number(v) as EventsDaysAhead)}
        />
      </SettingsField>

      <SettingsField label={m.taskPriority} description={m.taskPriorityDescription} error={() => undefined}>
        <SegmentedControl
          options={taskPriorityOptions}
          value={() => settings().tasksMinPriority ?? ""}
          onValueChange={(v) => updateSetting("tasksMinPriority", (v || null) as Priority | null)}
        />
      </SettingsField>
    </SettingsGroup>
  );
}

export function DefaultsSection(props: { spaceId: string; initialSettings: SpaceUserSettings }) {
  return (
    <>
      <LocalSettingsForm spaceId={props.spaceId} initialSettings={props.initialSettings} />
      <WidgetSettingsForm />
    </>
  );
}
