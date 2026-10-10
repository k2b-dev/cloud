import { Button, ButtonLink, IconInput, prompts, SegmentedControl, Select, TextInput, useLocale } from "@k2b/ui";
import { createSignal, For, Show } from "solid-js";
import {
  DASHBOARD_MAX_HREF_LENGTH,
  DASHBOARD_MAX_TITLE_LENGTH,
  type DashboardAppSummary,
  type DashboardShortcut,
  isSafeDashboardShortcutHref,
  normalizeDashboardShortcutHref,
} from "../shared";
import { dashboardMessages } from "./messages";

const useDashboardText = () => {
  const locale = useLocale();
  return () => dashboardMessages.resolve([locale()]).t;
};

const isExternalHref = (href: string): boolean => /^https?:\/\//i.test(href);

type ResolvedShortcut = { id: string; title: string; icon: string; href: string };

const resolveShortcuts = (shortcuts: readonly DashboardShortcut[], apps: readonly DashboardAppSummary[]): ResolvedShortcut[] => {
  const appById = new Map(apps.map((app) => [app.id, app]));
  return shortcuts.flatMap((shortcut) => {
    if (shortcut.kind === "link") return [{ id: shortcut.id, title: shortcut.title, icon: shortcut.icon, href: shortcut.href }];
    const app = appById.get(shortcut.appId);
    return app ? [{ id: shortcut.id, title: shortcut.title ?? app.name, icon: shortcut.icon ?? app.icon, href: app.href }] : [];
  });
};

/**
 * The shortcuts under the greeting. While the board is edited each one gets a remove button and a last button adds
 * one; the row keeps its height in both modes, and on a phone it scrolls sideways instead of wrapping.
 */
export function DashboardShortcuts(props: {
  shortcuts: readonly DashboardShortcut[];
  apps: readonly DashboardAppSummary[];
  editing: boolean;
  onRemove: (id: string) => void;
  onAdd: () => void;
}) {
  const t = useDashboardText();
  return (
    <nav aria-label={t().dashboardShortcuts} class="dashboard-shortcuts">
      <For each={resolveShortcuts(props.shortcuts, props.apps)}>
        {(shortcut) => (
          <span class="dashboard-shortcut">
            <ButtonLink
              href={shortcut.href}
              variant="secondary"
              size="sm"
              target={isExternalHref(shortcut.href) ? "_blank" : undefined}
              rel={isExternalHref(shortcut.href) ? "noreferrer" : undefined}
              tabIndex={props.editing ? -1 : undefined}
              class={props.editing ? "pointer-events-none" : undefined}
            >
              <i class={`${shortcut.icon} text-dimmed`} aria-hidden="true" />
              <span class="max-w-36 truncate">{shortcut.title}</span>
            </ButtonLink>
            <Show when={props.editing}>
              <button
                type="button"
                class="dashboard-remove dashboard-shortcut__remove"
                aria-label={t().removeNamed({ name: shortcut.title })}
                onClick={() => props.onRemove(shortcut.id)}
              >
                <i class="ti ti-x" aria-hidden="true" />
              </button>
            </Show>
          </span>
        )}
      </For>
      <Show when={props.editing}>
        <Button variant="ghost" size="sm" class="dashboard-shortcut-add" onClick={() => props.onAdd()}>
          <i class="ti ti-plus" aria-hidden="true" />
          {t().addShortcutShort}
        </Button>
      </Show>
    </nav>
  );
}

/** Asks for a new shortcut, an app or a link, and returns it without saving: the board saves it with Done. */
export const askForShortcut = (apps: readonly DashboardAppSummary[], title: string) =>
  prompts.dialog<DashboardShortcut>((close) => <ShortcutForm apps={apps} close={close} />, { title, icon: "ti ti-plus", size: "medium" });

const ShortcutForm = (props: { apps: readonly DashboardAppSummary[]; close: (shortcut?: DashboardShortcut) => void }) => {
  const t = useDashboardText();
  const [kind, setKind] = createSignal<"app" | "link">(props.apps.length > 0 ? "app" : "link");
  const [appId, setAppId] = createSignal(props.apps[0]?.id ?? "");
  const [title, setTitle] = createSignal("");
  const [href, setHref] = createSignal("");
  const [icon, setIcon] = createSignal("ti ti-link");
  const normalizedHref = () => normalizeDashboardShortcutHref(href());
  const hrefError = () => (!href().trim() || isSafeDashboardShortcutHref(normalizedHref()) ? undefined : t().urlHint);
  const canSubmit = () =>
    kind() === "app" ? Boolean(appId()) : title().trim().length > 0 && href().trim().length > 0 && hrefError() === undefined;
  const submit = () => {
    if (!canSubmit()) return;
    props.close(
      kind() === "app"
        ? { id: crypto.randomUUID(), kind: "app", appId: appId() }
        : { id: crypto.randomUUID(), kind: "link", title: title().trim(), href: normalizedHref(), icon: icon() || "ti ti-link" },
    );
  };

  return (
    <div class="flex flex-col gap-5">
      <SegmentedControl<"app" | "link">
        value={kind}
        onValueChange={setKind}
        ariaLabel={t().shortcutType}
        options={
          props.apps.length > 0
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
          options={props.apps.map((app) => ({ id: app.id, label: app.name, description: app.description, icon: app.icon }))}
          required
        />
      </Show>

      <div class="flex justify-end gap-2">
        <Button size="sm" onClick={submit} disabled={!canSubmit()}>
          {t().addShortcut}
        </Button>
      </div>
    </div>
  );
};
