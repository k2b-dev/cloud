import type { WidgetEndpoint } from "../contracts/app";
import { RoleSchema } from "../contracts/shared";
import {
  DASHBOARD_WIDGET_SIZES,
  isDashboardWidgetSize,
  WIDGET_DESCRIPTION_MAX_LENGTH,
  WIDGET_ID_MAX_LENGTH,
  WIDGET_TITLE_MAX_LENGTH,
} from "../contracts/widgets";
import { WidgetSettingsDeclarationSchema } from "./widget-settings";

const text = (value: string | undefined, label: string, max: number): string | undefined => {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  if (!normalized || normalized.length > max) throw new Error(`${label} must contain 1 to ${max} characters`);
  return normalized;
};

/**
 * Validates and copies an app's widget declarations at `defineApp()`, so a typo fails at startup instead of a widget
 * silently missing from the gallery: unique ids that fit Core's `widget.read:<id>` invocation, without `@`, which
 * separates a widget's key from the requested size, bounded titles and descriptions, known sizes with the default
 * among them, a boolean `suggest`, known roles, and a bounded settings declaration.
 */
export const compileWidgetDeclarations = (
  appId: string,
  widgets: ReadonlyArray<WidgetEndpoint> | undefined,
): WidgetEndpoint[] | undefined => {
  if (!widgets) return undefined;
  const ids = new Set<string>();
  return widgets.map((widget) => {
    const label = `Widget ${JSON.stringify(widget.id)} of app ${JSON.stringify(appId)}`;
    if (!widget.id.trim()) throw new Error(`Widgets of app ${JSON.stringify(appId)} need a non-empty id`);
    if (widget.id.includes("@")) throw new Error(`${label} must not contain "@"`);
    if (!/^[a-z0-9:._-]+$/.test(widget.id) || widget.id.length > WIDGET_ID_MAX_LENGTH) {
      throw new Error(
        `${label} id must use 1 to ${WIDGET_ID_MAX_LENGTH} lowercase letters, digits, ".", "_", "-", or ":" because Core invokes it as widget.read:<id>`,
      );
    }
    if (ids.has(widget.id)) throw new Error(`${label} is declared twice`);
    ids.add(widget.id);
    const sizes = widget.sizes ? [...widget.sizes] : undefined;
    if (sizes && (sizes.length === 0 || sizes.some((size) => !isDashboardWidgetSize(size)) || new Set(sizes).size !== sizes.length)) {
      throw new Error(`${label} must declare sizes as distinct values of ${DASHBOARD_WIDGET_SIZES.join(", ")}`);
    }
    if (widget.defaultSize !== undefined && !(sizes ?? ["large"]).includes(widget.defaultSize)) {
      throw new Error(`${label} must declare a defaultSize it offers in sizes`);
    }
    if (widget.suggest !== undefined && typeof widget.suggest !== "boolean")
      throw new Error(`${label} must declare suggest as true or false`);
    if (widget.requiresRoles?.some((role) => !RoleSchema.safeParse(role).success)) throw new Error(`${label} requires an unknown role`);
    const settings = widget.settings === undefined ? undefined : WidgetSettingsDeclarationSchema.safeParse(widget.settings);
    if (settings && !settings.success) {
      const issue = settings.error.issues[0]!;
      throw new Error(`${label} setting ${JSON.stringify(issue.path[0] ?? "settings")}: ${issue.message}`);
    }
    return {
      ...widget,
      ...(settings?.success ? { settings: settings.data } : {}),
      title: text(widget.title, `${label} title`, WIDGET_TITLE_MAX_LENGTH),
      description: text(widget.description, `${label} description`, WIDGET_DESCRIPTION_MAX_LENGTH),
      sizes: sizes ? DASHBOARD_WIDGET_SIZES.filter((size) => sizes.includes(size)) : undefined,
      requiresRoles: widget.requiresRoles ? [...widget.requiresRoles] : undefined,
    };
  });
};
