import { gradients } from "@k2b/stdlib";
import { mutation as mutations } from "@k2b/stdlib/solid";
import {
  Button,
  ButtonLink,
  Checkbox,
  IconButton,
  IconInput,
  Placeholder,
  prompts,
  SegmentedControl,
  Select,
  TextInput,
  Tooltip,
  toast,
  useLocale,
} from "@k2b/ui";
import type { DashboardWidgetSpan, DashboardWidgetZone } from "@valentinkolb/cloud/contracts";
import { openAppLaunchpad } from "@valentinkolb/cloud/ssr/islands";
import { createMemo, createSignal, For, Show } from "solid-js";
import { apiClient } from "../api/client";
import {
  DASHBOARD_MAX_HREF_LENGTH,
  DASHBOARD_MAX_TITLE_LENGTH,
  type DashboardAppSummary,
  type DashboardLegalLink,
  type DashboardSettings,
  type DashboardShortcut,
  type DashboardWidgetLayoutOverride,
  type DashboardWidgetSummary,
  isSafeDashboardShortcutHref,
  normalizeDashboardShortcutHref,
  resolveDashboardWidgetLayout,
} from "../shared";
import { dashboardMessages } from "./messages";

type Props = {
  apps: DashboardAppSummary[];
  legalLinks: DashboardLegalLink[];
  settings: DashboardSettings;
  available: DashboardWidgetSummary[];
  inaccessible: DashboardWidgetSummary[];
};

type ResolvedShortcut = {
  id: string;
  title: string;
  icon: string;
  href: string;
};

const errorMessage = async (response: Response, fallback: string): Promise<string> => {
  const body = await response.json().catch(() => null);
  if (body && typeof body === "object" && "message" in body && typeof body.message === "string") return body.message;
  return fallback;
};

const saveSettings = async (settings: DashboardSettings, fallback: string): Promise<void> => {
  const response = await apiClient.settings.$put({ json: settings });
  if (!response.ok) throw new Error(await errorMessage(response, fallback));
};

const useDashboardText = () => {
  const locale = useLocale();
  return () => dashboardMessages.resolve([locale()]).t;
};

const isExternalHref = (href: string): boolean => /^https?:\/\//i.test(href);

const ShortcutBadge = (props: { icon: string; title: string; href?: string; accent?: boolean; onClick?: () => void }) => {
  const iconClass = () => (props.accent ? "app-accent-text" : "text-dimmed");
  const content = (
    <>
      <span class={`grid h-5 w-5 shrink-0 place-items-center text-sm ${iconClass()}`}>
        <i class={props.icon} />
      </span>
      <span class="max-w-36 truncate text-sm font-medium text-primary">{props.title}</span>
    </>
  );
  return props.href ? (
    <ButtonLink
      href={props.href}
      variant="secondary"
      size="sm"
      class="max-w-full"
      target={isExternalHref(props.href) ? "_blank" : undefined}
      rel={isExternalHref(props.href) ? "noreferrer" : undefined}
    >
      {content}
    </ButtonLink>
  ) : (
    <Button variant="secondary" size="sm" class="max-w-full" onClick={props.onClick}>
      {content}
    </Button>
  );
};

export default function DashboardControls(props: Props) {
  const t = useDashboardText();
  const appById = createMemo(() => new Map(props.apps.map((app) => [app.id, app])));
  const resolvedShortcuts = createMemo<ResolvedShortcut[]>(() =>
    props.settings.shortcuts
      .map((shortcut) => {
        if (shortcut.kind === "link") return { id: shortcut.id, title: shortcut.title, icon: shortcut.icon, href: shortcut.href };
        const app = appById().get(shortcut.appId);
        if (!app) return null;
        return {
          id: shortcut.id,
          title: shortcut.title ?? app.name,
          icon: shortcut.icon ?? app.icon,
          href: app.href,
        };
      })
      .filter((shortcut): shortcut is ResolvedShortcut => Boolean(shortcut)),
  );

  const openApps = () => {
    openAppLaunchpad(
      props.apps.map((app) => ({
        id: app.id,
        iconClass: app.icon,
        label: app.name,
        href: app.href,
        description: app.description,
      })),
      props.legalLinks,
    );
  };

  const openAddShortcut = () => {
    void prompts.dialog<void>((close) => <ShortcutForm apps={props.apps} settings={props.settings} close={close} />, {
      title: t().addShortcut,
      icon: "ti ti-plus",
      size: "medium",
    });
  };

  return (
    <nav aria-label={t().dashboardShortcuts} class="flex flex-wrap gap-2">
      <ShortcutBadge icon="ti ti-grid-dots" title={t().apps} accent onClick={openApps} />
      <ShortcutBadge icon="ti ti-plus" title={t().addShortcut} onClick={openAddShortcut} />
      <For each={resolvedShortcuts()}>
        {(shortcut) => <ShortcutBadge icon={shortcut.icon} title={shortcut.title} href={shortcut.href} />}
      </For>
    </nav>
  );
}

export function DashboardEditButton(props: Props) {
  const t = useDashboardText();
  const openAddShortcut = () => {
    void prompts.dialog<void>((close) => <ShortcutForm apps={props.apps} settings={props.settings} close={close} />, {
      title: t().addShortcut,
      icon: "ti ti-plus",
      size: "medium",
    });
  };

  const openEdit = () => {
    void prompts.dialog<void>((close) => <EditForm props={props} close={close} onAddShortcut={openAddShortcut} />, {
      title: t().editDashboard,
      icon: "ti ti-adjustments",
      size: "large",
    });
  };

  return (
    <Button variant="secondary" size="sm" class="shrink-0" onClick={openEdit}>
      <i class="ti ti-adjustments" />
      {t().editDashboard}
    </Button>
  );
}

const ShortcutForm = (params: { apps: DashboardAppSummary[]; settings: DashboardSettings; close: (r?: void) => void }) => {
  const t = useDashboardText();
  const { apps, settings, close } = params;
  const [kind, setKind] = createSignal<"app" | "link">(apps.length > 0 ? "app" : "link");
  const [appId, setAppId] = createSignal(apps[0]?.id ?? "");
  const [title, setTitle] = createSignal("");
  const [href, setHref] = createSignal("");
  const [icon, setIcon] = createSignal("ti ti-link");
  const normalizedHref = () => normalizeDashboardShortcutHref(href());
  const hrefError = () => {
    if (!href().trim() || isSafeDashboardShortcutHref(normalizedHref())) return undefined;
    return t().urlHint;
  };
  const canSubmit = () =>
    kind() === "app" ? Boolean(appId()) : title().trim().length > 0 && href().trim().length > 0 && hrefError() === undefined;

  const save = mutations.create<void, void>({
    mutation: async () => {
      const shortcut: DashboardShortcut =
        kind() === "app"
          ? { id: crypto.randomUUID(), kind: "app", appId: appId() }
          : {
              id: crypto.randomUUID(),
              kind: "link",
              title: title().trim(),
              href: normalizedHref(),
              icon: icon() || "ti ti-link",
            };
      await saveSettings({ ...settings, shortcuts: [...settings.shortcuts, shortcut] }, t().saveSettingsFailed);
    },
    onSuccess: () => {
      close();
      toast.success(t().shortcutAdded);
      window.location.reload();
    },
    onError: (error) => prompts.error(error instanceof Error ? error.message : t().addShortcutFailed),
  });

  return (
    <div class="flex flex-col gap-5">
      <SegmentedControl<"app" | "link">
        value={kind}
        onValueChange={setKind}
        ariaLabel={t().shortcutType}
        options={
          apps.length > 0
            ? [
                { value: "app", label: t().app, icon: "ti ti-apps" },
                { value: "link", label: t().link, icon: "ti ti-link" },
              ]
            : [{ value: "link", label: t().link, icon: "ti ti-link" }]
        }
      />

      <Show
        when={kind() === "app"}
        fallback={
          <div class="grid gap-4 sm:grid-cols-2">
            <TextInput
              label={t().titleLabel}
              value={title}
              onValueChange={setTitle}
              icon="ti ti-text-caption"
              required
              maxLength={DASHBOARD_MAX_TITLE_LENGTH}
              placeholder="Docs"
            />
            <TextInput
              label={t().url}
              value={href}
              onValueChange={setHref}
              error={hrefError}
              icon="ti ti-link"
              inputMode="url"
              autocomplete="url"
              spellcheck={false}
              required
              maxLength={DASHBOARD_MAX_HREF_LENGTH}
              placeholder="example.com"
            />
            <div class="sm:col-span-2">
              <IconInput label={t().icon} value={icon} onValueChange={(value) => setIcon(value ?? "")} required clearable={false} />
            </div>
          </div>
        }
      >
        <Select
          label={t().app}
          icon="ti ti-apps"
          value={appId}
          onValueChange={(value) => setAppId(value ?? "")}
          options={apps.map((app) => ({ id: app.id, label: app.name, description: app.description, icon: app.icon }))}
          required
        />
      </Show>

      <div class="flex justify-end gap-2">
        <Button variant="secondary" size="sm" onClick={() => close()}>
          {t().cancel}
        </Button>
        <Button size="sm" onClick={() => save.mutate()} disabled={!canSubmit()} loading={save.loading()} loadingLabel={t().addingShortcut}>
          {t().addShortcut}
        </Button>
      </div>
    </div>
  );
};

const EditForm = (params: { props: Props; close: (r?: void) => void; onAddShortcut: () => void }) => {
  const t = useDashboardText();
  const { props, close, onAddShortcut } = params;
  const [hidden, setHidden] = createSignal<string[]>([...props.settings.hiddenWidgets]);
  const [gradient, setGradient] = createSignal<string>(props.settings.gradient);
  const [shortcuts, setShortcuts] = createSignal<DashboardShortcut[]>([...props.settings.shortcuts]);
  const initialLayout = resolveDashboardWidgetLayout(props.available, props.settings.layout);
  const [widgetOrder, setWidgetOrder] = createSignal(initialLayout.map(({ widget }) => widget.key));
  const [layoutOverrides, setLayoutOverrides] = createSignal<DashboardWidgetLayoutOverride[]>([...props.settings.layout.widgets]);
  const [layoutTouched, setLayoutTouched] = createSignal(false);

  const toggleWidget = (key: string) => {
    const current = hidden();
    setHidden(current.includes(key) ? current.filter((k) => k !== key) : [...current, key]);
  };

  const removeShortcut = (id: string) => setShortcuts(shortcuts().filter((shortcut) => shortcut.id !== id));
  const resolvedWidgets = createMemo(() =>
    resolveDashboardWidgetLayout(props.available, {
      widgets: layoutOverrides(),
      order: widgetOrder(),
    }),
  );
  const resolvedByKey = createMemo(() => new Map(resolvedWidgets().map((item) => [item.widget.key, item])));
  const orderedWidgets = createMemo(() => resolvedWidgets().map(({ widget }) => widget));

  const updateWidgetLayout = (key: string, change: { zone?: DashboardWidgetZone; span?: DashboardWidgetSpan }) => {
    const resolved = resolvedByKey().get(key);
    const current = layoutOverrides().find((entry) => entry.key === key);
    const zone = change.zone ?? current?.zone ?? resolved?.zone ?? "overview";
    const next: DashboardWidgetLayoutOverride = {
      key,
      zone,
      span: zone === "context" ? "standard" : (change.span ?? current?.span ?? resolved?.span ?? "standard"),
    };
    setLayoutOverrides([...layoutOverrides().filter((entry) => entry.key !== key), next]);
    setLayoutTouched(true);
  };

  const resetWidgetLayout = (key: string) => {
    setLayoutOverrides(layoutOverrides().filter((entry) => entry.key !== key));
    setLayoutTouched(true);
  };

  const moveWidget = (key: string, offset: -1 | 1) => {
    const order = [...widgetOrder()];
    const index = order.indexOf(key);
    const target = index + offset;
    if (index < 0 || target < 0 || target >= order.length) return;
    [order[index], order[target]] = [order[target]!, order[index]!];
    setWidgetOrder(order);
    setLayoutTouched(true);
  };

  const save = mutations.create<void, void>({
    mutation: async () => {
      await saveSettings(
        {
          hiddenWidgets: hidden(),
          gradient: gradient(),
          shortcuts: shortcuts(),
          layout: layoutTouched() ? { widgets: layoutOverrides(), order: widgetOrder() } : props.settings.layout,
        },
        t().saveSettingsFailed,
      );
    },
    onSuccess: () => {
      close();
      toast.success(t().dashboardUpdated);
      window.location.reload();
    },
    onError: (error) => prompts.error(error instanceof Error ? error.message : t().saveDashboardFailed),
  });

  const appById = createMemo(() => new Map(props.apps.map((app) => [app.id, app])));

  return (
    <div class="flex max-h-[70vh] flex-col gap-6 overflow-y-auto px-1 pb-1">
      <section class="flex flex-col gap-2">
        <span class="text-[11px] uppercase tracking-wider text-dimmed">{t().nameColor}</span>
        <div class="flex flex-wrap gap-2">
          <For each={gradients.gradientPresets}>
            {(preset) => (
              <Tooltip.Anchor content={preset.label}>
                <button
                  type="button"
                  aria-label={t().nameColorLabel({ name: preset.label })}
                  aria-pressed={gradient() === preset.id}
                  onClick={() => setGradient(preset.id)}
                  class={`h-7 w-7 rounded-full transition-all ${
                    gradient() === preset.id
                      ? "ring-2 ring-[var(--ui-app-accent-border)] ring-offset-2 ring-offset-[var(--ui-dialog-surface)]"
                      : "hover:scale-110"
                  }`}
                  style={`background:${preset.preview}`}
                />
              </Tooltip.Anchor>
            )}
          </For>
        </div>
      </section>

      <section class="flex flex-col gap-3">
        <div class="flex items-center justify-between gap-3">
          <span class="text-[11px] uppercase tracking-wider text-dimmed">{t().shortcuts}</span>
          <Button variant="secondary" size="sm" onClick={onAddShortcut}>
            <i class="ti ti-plus" />
            {t().add}
          </Button>
        </div>
        <Show when={shortcuts().length > 0} fallback={<Placeholder align="left" class="px-0 py-2" description={<>{t().noShortcuts}</>} />}>
          <ul class="flex flex-col gap-2">
            <For each={shortcuts()}>
              {(shortcut) => {
                const app = shortcut.kind === "app" ? appById().get(shortcut.appId) : null;
                const title = shortcut.kind === "link" ? shortcut.title : (shortcut.title ?? app?.name ?? t().unknownApp);
                const icon = shortcut.kind === "link" ? shortcut.icon : (shortcut.icon ?? app?.icon ?? "ti ti-apps");
                const meta = shortcut.kind === "link" ? shortcut.href : (app?.description ?? shortcut.appId);
                return (
                  <li class="flex items-center gap-3 rounded-[var(--ui-radius-control)] bg-[var(--ui-surface-subtle)] p-2">
                    <span class="grid h-10 w-10 shrink-0 place-items-center rounded-[var(--ui-radius-control)] bg-[var(--ui-surface)] text-lg text-secondary">
                      <i class={icon} />
                    </span>
                    <span class="min-w-0 flex-1">
                      <span class="block truncate text-sm font-medium text-primary">{title}</span>
                      <span class="block truncate text-xs text-dimmed">{meta}</span>
                    </span>
                    <Tooltip.Anchor content={t().removeShortcut}>
                      <IconButton size="sm" label={t().removeNamed({ name: title })} onClick={() => removeShortcut(shortcut.id)}>
                        <i class="ti ti-trash" />
                      </IconButton>
                    </Tooltip.Anchor>
                  </li>
                );
              }}
            </For>
          </ul>
        </Show>
      </section>

      <Show when={props.available.length > 0}>
        <section class="flex flex-col gap-3">
          <div>
            <span class="text-[11px] uppercase tracking-wider text-dimmed">{t().widgets}</span>
            <p class="mt-1 text-xs text-dimmed">{t().widgetsDescription}</p>
          </div>
          <ul class="flex flex-col gap-2">
            <For each={orderedWidgets()}>
              {(widget, index) => {
                const resolved = () => resolvedByKey().get(widget.key);
                const overridden = () => layoutOverrides().some((entry) => entry.key === widget.key);
                const recommendation = () => {
                  const parts = [
                    widget.presentation?.defaultZone === "focus" ? t().focus : null,
                    widget.presentation?.defaultZone === "context" ? t().side : null,
                    widget.presentation?.defaultSpan === "wide" ? t().wide : null,
                  ].filter(Boolean);
                  return parts.length > 0 ? t().recommendation({ values: parts.join(" · ") }) : null;
                };
                return (
                  <li class="flex flex-col gap-3 rounded-[var(--ui-radius-control)] bg-[var(--ui-surface-subtle)] p-3">
                    <div class="flex min-w-0 items-center gap-3">
                      <Checkbox
                        class="min-w-0 flex-1"
                        value={() => !hidden().includes(widget.key)}
                        onValueChange={() => toggleWidget(widget.key)}
                        label={
                          <span class="flex min-w-0 items-center gap-3">
                            <i class={`${widget.icon} shrink-0 text-sm text-dimmed`} />
                            <span class="min-w-0 flex-1">
                              <span class="block truncate text-sm font-medium text-primary">{widget.title}</span>
                              <Show when={recommendation()}>{(label) => <span class="block text-[11px] text-dimmed">{label()}</span>}</Show>
                            </span>
                          </span>
                        }
                      />
                      <div class="flex shrink-0 items-center gap-1">
                        <Tooltip.Anchor content={t().moveUp} disabled={index() === 0}>
                          <IconButton
                            size="sm"
                            label={t().moveNamedUp({ name: widget.title })}
                            disabled={index() === 0}
                            onClick={() => moveWidget(widget.key, -1)}
                          >
                            <i class="ti ti-arrow-up" />
                          </IconButton>
                        </Tooltip.Anchor>
                        <Tooltip.Anchor content={t().moveDown} disabled={index() === orderedWidgets().length - 1}>
                          <IconButton
                            size="sm"
                            label={t().moveNamedDown({ name: widget.title })}
                            disabled={index() === orderedWidgets().length - 1}
                            onClick={() => moveWidget(widget.key, 1)}
                          >
                            <i class="ti ti-arrow-down" />
                          </IconButton>
                        </Tooltip.Anchor>
                      </div>
                    </div>

                    <div class="flex flex-wrap items-center gap-2 pl-7">
                      <SegmentedControl<DashboardWidgetZone>
                        value={() => resolved()?.zone ?? "overview"}
                        onValueChange={(zone) => updateWidgetLayout(widget.key, { zone })}
                        ariaLabel={t().sectionLabel({ name: widget.title })}
                        options={[
                          { value: "focus", label: t().focus, icon: "ti ti-focus-2" },
                          { value: "overview", label: t().overview, icon: "ti ti-layout-grid" },
                          { value: "context", label: t().side, icon: "ti ti-layout-sidebar-right" },
                        ]}
                      />
                      <Show when={resolved()?.zone !== "context"}>
                        <SegmentedControl<DashboardWidgetSpan>
                          value={() => resolved()?.span ?? "standard"}
                          onValueChange={(span) => updateWidgetLayout(widget.key, { span })}
                          ariaLabel={t().widthLabel({ name: widget.title })}
                          options={[
                            { value: "standard", label: t().standard },
                            { value: "wide", label: t().wide },
                          ]}
                        />
                      </Show>
                      <Show when={overridden()}>
                        <Button variant="ghost" size="sm" onClick={() => resetWidgetLayout(widget.key)}>
                          {t().reset}
                        </Button>
                      </Show>
                    </div>
                  </li>
                );
              }}
            </For>
          </ul>
        </section>
      </Show>

      <Show when={props.inaccessible.length > 0}>
        <section class="flex flex-col gap-2">
          <span class="text-[11px] uppercase tracking-wider text-dimmed">{t().inaccessible}</span>
          <ul class="grid gap-2 sm:grid-cols-2">
            <For each={props.inaccessible}>
              {(widget) => (
                <li class="flex items-center gap-3 rounded-[var(--ui-radius-control)] bg-[var(--ui-surface-subtle)] p-2 opacity-60">
                  <i class="ti ti-lock text-xs text-dimmed" />
                  <i class={`${widget.icon} text-sm text-dimmed`} />
                  <span class="min-w-0 truncate text-sm text-secondary">{widget.title}</span>
                </li>
              )}
            </For>
          </ul>
        </section>
      </Show>

      <p class="text-[11px] text-dimmed">{t().settingsPersistence}</p>

      <div class="flex justify-end gap-2 pt-2">
        <Button variant="secondary" size="sm" onClick={() => close()}>
          {t().cancel}
        </Button>
        <Button size="sm" onClick={() => save.mutate()} loading={save.loading()} loadingLabel={t().savingDashboard}>
          {t().save}
        </Button>
      </div>
    </div>
  );
};
