import { IconButton, MultiSelectInput, SegmentedControl, Switch, Tooltip, useLocale } from "@k2b/ui";
import { refreshCurrentPath } from "@k2b/ssr/nav";
import { cookies } from "@k2b/stdlib/browser";
import { createSignal, Show } from "solid-js";
import { filesMessages } from "../messages";

/** Cookie name for file settings */
const COOKIE_NAME = "settings-app-files";

/** View mode type */
export type ViewMode = "list" | "grid";
export type FileListColumn = "size" | "mime" | "modified";
export type ListDensity = "comfortable" | "compact";

/** Grid size options */
export type GridSize = "s" | "m" | "l" | "xl";

const GRID_SIZE_VALUES: Record<GridSize, number> = {
  s: 64,
  m: 92,
  l: 136,
  xl: 184,
};

/** File settings structure */
export type FileSettings = {
  computeSizes: boolean;
  viewMode: ViewMode;
  showHidden: boolean;
  gridSize: GridSize;
  hideSettings: boolean;
  listColumns: FileListColumn[];
  listDensity: ListDensity;
};

/** Default settings */
export const DEFAULT_FILE_SETTINGS: FileSettings = {
  computeSizes: false,
  viewMode: "list",
  showHidden: false,
  gridSize: "m",
  hideSettings: false,
  listColumns: ["size", "modified"],
  listDensity: "comfortable",
};

/** Get pixel value for grid size */
export const getGridSizePixels = (size: GridSize): number => GRID_SIZE_VALUES[size];

/** Write settings to cookie */
const writeSettings = (settings: FileSettings) => cookies.writeJsonCookie(COOKIE_NAME, settings);

type FileSettingsProps = {
  /** Initial settings from server-side cookie read */
  initialSettings: FileSettings;
};

const GRID_SIZE_OPTIONS: { value: GridSize; label: string }[] = [
  { value: "s", label: "S" },
  { value: "m", label: "M" },
  { value: "l", label: "L" },
  { value: "xl", label: "XL" },
];

/**
 * File manager settings panel (desktop only).
 * Persists settings in a JSON cookie for server-side access.
 */
export default function FileSettings({ initialSettings }: FileSettingsProps) {
  const locale = useLocale();
  const t = () => filesMessages.resolve([locale()]).t;
  const [settings, setSettings] = createSignal<FileSettings>(initialSettings);
  const listColumnOptions = () => [
    { value: "size" as const, label: t().fileSize, icon: "ti ti-ruler-measure" },
    { value: "mime" as const, label: t().mimeType, icon: "ti ti-file-type" },
    { value: "modified" as const, label: t().updated, icon: "ti ti-clock" },
  ];

  const updateSetting = <K extends keyof FileSettings>(key: K, value: FileSettings[K]) => {
    const newSettings = { ...settings(), [key]: value };
    setSettings(newSettings);
    writeSettings(newSettings);
    // Reload to apply new setting server-side (except for hideSettings)
    if (key !== "hideSettings") {
      refreshCurrentPath();
    }
  };

  const toggleMinimize = () => {
    updateSetting("hideSettings", !settings().hideSettings);
  };

  return (
    <div id="files-sidebar-settings" class="flex flex-col gap-3 px-1 pt-1">
      {/* Header with minimize toggle */}
      <div class="flex items-center justify-between">
        <p class="sidebar-section-title pt-0">{t().panel}</p>
        <Tooltip.Anchor content={settings().hideSettings ? t().expandSettings : t().minimizeSettings}>
          <IconButton
            onClick={toggleMinimize}
            label={settings().hideSettings ? t().expandSettings : t().minimizeSettings}
            size="xs"
            variant="ghost"
          >
            <i class={`ti ${settings().hideSettings ? "ti-chevron-down" : "ti-chevron-up"} text-sm`} />
          </IconButton>
        </Tooltip.Anchor>
      </div>

      <Show when={!settings().hideSettings}>
        <div class="flex flex-col gap-3">
          {/* View mode toggle */}
          <SegmentedControl
            options={[
              { value: "list" as ViewMode, label: t().list, icon: "ti ti-list" },
              {
                value: "grid" as ViewMode,
                label: t().grid,
                icon: "ti ti-grid-dots",
              },
            ]}
            value={() => settings().viewMode}
            onValueChange={(v) => updateSetting("viewMode", v)}
          />

          {/* Grid size options (only shown in grid mode) */}
          <Show when={settings().viewMode === "grid"}>
            <div class="flex flex-col gap-1">
              <div class="text-xs text-secondary">{t().iconSize}</div>
              <SegmentedControl
                options={GRID_SIZE_OPTIONS}
                value={() => settings().gridSize}
                onValueChange={(v) => updateSetting("gridSize", v)}
              />
            </div>
          </Show>

          <Show when={settings().viewMode === "list"}>
            <div class="flex flex-col gap-3">
              <div class="flex flex-col gap-1">
                <div class="text-xs text-secondary">{t().density}</div>
                <SegmentedControl
                  options={[
                    { value: "compact" as ListDensity, label: t().compact },
                    { value: "comfortable" as ListDensity, label: t().cozy },
                  ]}
                  value={() => settings().listDensity}
                  onValueChange={(v) => updateSetting("listDensity", v)}
                />
              </div>

              <div class="flex flex-col gap-1.5">
                <MultiSelectInput
                  label={t().listColumns}
                  value={() => settings().listColumns}
                  options={listColumnOptions().map((option) => ({ id: option.value, label: option.label, icon: option.icon }))}
                  searchable={false}
                  placeholder={t().noExtraColumns}
                  onValueChange={(columns) => updateSetting("listColumns", columns as FileListColumn[])}
                />
              </div>
            </div>
          </Show>

          {/* Show hidden files toggle */}
          <Switch label={t().showHidden} value={() => settings().showHidden} onValueChange={(v) => updateSetting("showHidden", v)} />

          {/* Compute sizes toggle */}
          <div class="flex flex-col gap-1">
            <Switch
              label={t().preciseSizes}
              value={() => settings().computeSizes}
              onValueChange={(v) => updateSetting("computeSizes", v)}
            />
            <Show when={settings().computeSizes}>
              <p class="text-[10px] text-orange-500 pl-11">{t().maySlow}</p>
            </Show>
          </div>
        </div>
      </Show>
    </div>
  );
}

/** Parse settings from cookie string (for server-side use) */
export const parseFileSettings = (cookieHeader: string | undefined): FileSettings => {
  if (!cookieHeader) return DEFAULT_FILE_SETTINGS;
  try {
    const match = cookieHeader.match(new RegExp(`${COOKIE_NAME}=([^;]+)`));
    if (match) {
      const parsed = JSON.parse(decodeURIComponent(match[1]!)) as Partial<FileSettings>;
      const listColumns = Array.isArray(parsed.listColumns)
        ? parsed.listColumns.filter((value): value is FileListColumn => ["size", "mime", "modified"].includes(String(value)))
        : DEFAULT_FILE_SETTINGS.listColumns;
      const listDensity = parsed.listDensity === "compact" ? "compact" : DEFAULT_FILE_SETTINGS.listDensity;
      return {
        ...DEFAULT_FILE_SETTINGS,
        ...parsed,
        listColumns,
        listDensity,
      };
    }
  } catch {
    // Ignore parse errors
  }
  return DEFAULT_FILE_SETTINGS;
};
