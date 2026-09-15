import { documentNavigate, Link } from "@k2b/ssr/nav";
import { createSignal, For, Show } from "solid-js";
import { Dropdown } from "../actions/Dropdown";
import { useUiMessages } from "../intl/messages";
import { type NavigationController, type NavigationItem } from "./navigation-model";

export type NavigationProps = {
  navigation: NavigationController;
  label: string;
  /** A host can finish dismissing its menu before the selected operation runs. */
  beforeSelect?: () => boolean | void | Promise<boolean | void>;
};

export default function Navigation(props: NavigationProps) {
  const messages = useUiMessages();
  const [expanded, setExpanded] = createSignal<Record<string, boolean>>({});
  const ready = async () => (await props.beforeSelect?.()) !== false;
  const activate = async (id: string) => {
    if (await ready()) await props.navigation.activate(id);
  };
  const Rows = (rows: { items: readonly NavigationItem[]; disabled?: boolean }) => (
    <ul class="k2b-navigation__list">
      <For each={rows.items.map((item) => item.id)}>
        {(id) => {
          const item = () => rows.items.find((entry) => entry.id === id)!;
          const disabled = () => rows.disabled || item().disabled;
          const open = () => expanded()[id] ?? true;
          const toggle = () => setExpanded((current) => ({ ...current, [id]: !open() }));
          const content = () => (
            <>
              <Show when={item().icon}>
                <i class={item().icon} aria-hidden="true" />
              </Show>
              <span class="k2b-navigation__copy">
                <span>{item().label}</span>
                <Show when={item().description}>
                  <small>{item().description}</small>
                </Show>
              </span>
              <Show when={item().color}>
                <span class="k2b-navigation__color" style={{ "background-color": item().color }} />
              </Show>
              <Show when={item().badge !== undefined}>
                <span class="k2b-navigation__badge">{item().badge}</span>
              </Show>
            </>
          );
          return (
            <li>
              <div class="k2b-navigation__row" data-active={item().active || undefined}>
                <Show
                  when={item().href}
                  fallback={
                    <button
                      type="button"
                      class="k2b-navigation__control"
                      disabled={disabled()}
                      aria-expanded={!item().action ? open() : undefined}
                      onClick={() => (item().action ? void activate(id) : toggle())}
                    >
                      {content()}
                    </button>
                  }
                >
                  {(href) => (
                    <Link
                      class="k2b-navigation__control"
                      href={href()}
                      aria-current={item().active ? "page" : undefined}
                      aria-disabled={disabled() || undefined}
                      tabIndex={disabled() ? -1 : undefined}
                      scroll={item().scroll}
                      onNavigate={async (event) => {
                        if (!(await ready())) return;
                        if (item().navigation === "enhanced" && props.navigation.onNavigate) await props.navigation.onNavigate(event);
                        else event.fallback();
                      }}
                      onClick={(event) => {
                        if (disabled()) {
                          event.preventDefault();
                          return;
                        }
                        if (!item().action || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
                          return;
                        // Local opening can fetch before committing navigation, outside a view transition.
                        event.preventDefault();
                        void activate(id);
                      }}
                    >
                      {content()}
                    </Link>
                  )}
                </Show>
                <Show when={(item().href || item().action) && item().children?.length}>
                  <button
                    type="button"
                    class="k2b-navigation__disclosure"
                    aria-label={item().label}
                    aria-expanded={open()}
                    disabled={disabled()}
                    onClick={toggle}
                  >
                    <i class={open() ? "ti ti-chevron-down" : "ti ti-chevron-right"} aria-hidden="true" />
                  </button>
                </Show>
                <Show when={item().actions?.length}>
                  <Dropdown.Root
                    items={(item().actions ?? []).map((action) => ({
                      label: action.label,
                      icon: action.icon,
                      disabled: disabled() || action.disabled,
                      action: () => {
                        if (action.href)
                          void ready().then((allowed) => {
                            if (allowed) documentNavigate(action.href!);
                          });
                        else void activate(action.id);
                      },
                    }))}
                  >
                    <Dropdown.Trigger iconOnly label={`${item().label}: ${messages().rowAction}`} variant="ghost">
                      <i class="ti ti-dots" aria-hidden="true" />
                    </Dropdown.Trigger>
                  </Dropdown.Root>
                </Show>
              </div>
              <Show when={item().children?.length}>
                <div hidden={!open()}>
                  <Rows items={item().children ?? []} disabled={disabled()} />
                </div>
              </Show>
            </li>
          );
        }}
      </For>
    </ul>
  );
  return (
    <nav class="k2b-navigation" aria-label={props.label}>
      <Rows items={props.navigation.items()} />
    </nav>
  );
}
