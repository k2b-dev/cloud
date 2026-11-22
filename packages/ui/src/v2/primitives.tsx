/**
 * @k2b/ui v2 (spike draft): the static, server-rendered primitives of the flat look. Every primitive owns exactly its
 * own lines and its own text edge; no primitive pads or indents its children. A row is a row, a band is a band.
 * Interaction lives in the overlays (ui-sdk) and in one behaviour module (overlay scrollbars).
 */
import { For, type ParentProps, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { type IconName, iconPaths } from "./icons";

// ── Icon: its own size, never a text role ──────────────────────────────────────────────────────────────────────────
export function Icon(props: { name: IconName; size?: "md" | "lg"; label?: string }) {
  return (
    <svg
      class="k2-icon"
      data-size={props.size === "lg" ? "lg" : undefined}
      viewBox="0 0 24 24"
      role={props.label ? "img" : undefined}
      aria-label={props.label}
      aria-hidden={props.label ? undefined : "true"}
    >
      <For each={iconPaths[props.name]}>{(d) => <path d={d} />}</For>
    </svg>
  );
}

// ── Shell: the app card and its columns ────────────────────────────────────────────────────────────────────────────
/** The app frame. `detail` opens the third column (a drawer on tablets, its own page on phones). */
export function Shell(props: ParentProps<{ detail?: boolean }>) {
  return (
    <div class="k2-shell">
      <div class="k2-card" data-detail={props.detail ? "" : undefined}>
        {props.children}
      </div>
    </div>
  );
}

/** One column of the card. `region` names it for layout rules and for the flat checks. */
export function Column(props: ParentProps<{ region: "main" | "detail"; label: string }>) {
  return (
    <section class="k2-col" data-region={props.region} data-layout-area="" aria-label={props.label}>
      {props.children}
    </section>
  );
}

/** The sidebar column: app title, then labels and nav items. */
export function Sidebar(props: ParentProps<{ title: string; icon: IconName }>) {
  return (
    <nav class="k2-col k2-side" data-layout-area="" aria-label={props.title}>
      <div class="k2-side__title">
        <Icon name={props.icon} size="lg" />
        {props.title}
      </div>
      {props.children}
    </nav>
  );
}

export function SideLabel(props: ParentProps) {
  return <div class="k2-side__label">{props.children}</div>;
}

export function NavItem(props: ParentProps<{ href: string; icon: IconName; current?: boolean; count?: number }>) {
  return (
    <a class="k2-nav" href={props.href} aria-current={props.current ? "page" : undefined}>
      <Icon name={props.icon} />
      <span class="k2-fill k2-cut">{props.children}</span>
      <Show when={props.count}>
        <span class="k2-nav__count">{props.count}</span>
      </Show>
    </a>
  );
}

/** The 56 px head of a column: views or a title left, actions right, its line below. */
export function Head(props: ParentProps<{ title?: string; actions?: JSX.Element; edge?: "end" }>) {
  return (
    <header class="k2-head" data-edge={props.edge}>
      <Show when={props.title}>
        <h2 class="k2-head__title">{props.title}</h2>
      </Show>
      {props.children}
      <Show when={props.actions}>
        <div class="k2-head__acts">{props.actions}</div>
      </Show>
    </header>
  );
}

export type TabItem = { href: string; label: string; count?: number; current?: boolean };

export function Tabs(props: { label: string; items: TabItem[] }) {
  return (
    <nav class="k2-tabs" aria-label={props.label}>
      <For each={props.items}>
        {(tab) => (
          <a class="k2-tab" href={tab.href} aria-current={tab.current ? "page" : undefined}>
            {tab.label}
            <Show when={tab.count !== undefined}>
              <span class="k2-tab__n">{tab.count}</span>
            </Show>
          </a>
        )}
      </For>
    </nav>
  );
}

/** The status row: one lead statement, at most three facts, filters on the right. */
export function StatusRow(props: { lead: string; facts?: JSX.Element[]; filters?: JSX.Element }) {
  return (
    <div class="k2-status">
      <span class="k2-status__lead">{props.lead}</span>
      <For each={(props.facts ?? []).slice(0, 3)}>{(fact) => <span class="k2-status__fact">{fact}</span>}</For>
      <Show when={props.filters}>
        <div class="k2-status__filters">{props.filters}</div>
      </Show>
    </div>
  );
}

/** The one scroller of a column. Its overlay scrollbar takes no room, so every line below reaches the column edge. */
export function Scroll(props: ParentProps<{ label?: string }>) {
  return (
    <div class="k2-scroll" data-scrollbar="overlay" tabindex="0" aria-label={props.label}>
      {props.children}
      <div class="k2-scrollbar" aria-hidden="true">
        <span />
      </div>
    </div>
  );
}

// ── Rows ──────────────────────────────────────────────────────────────────────────────────────────────────────────
export function List(props: ParentProps<{ label: string }>) {
  return (
    <ul class="k2-list" aria-label={props.label}>
      {props.children}
    </ul>
  );
}

/**
 * A row owns its line and its text edge from column edge to column edge. With `href` it is a link (selection lives in
 * the URL, so the server renders it); `lines` 3 makes the 72 px stacked row.
 */
export function Row(props: ParentProps<{ href?: string; current?: boolean; lines?: 1 | 3; lead?: JSX.Element; end?: JSX.Element }>) {
  const body = () => (
    <>
      {props.lead}
      <div class="k2-row__main">{props.children}</div>
      {props.end}
    </>
  );
  return (
    <li style={{ display: "contents" }}>
      <Show
        when={props.href}
        fallback={
          <div class="k2-row" data-size={props.lines === 3 ? "3" : undefined}>
            {body()}
          </div>
        }
      >
        <a class="k2-row" href={props.href} data-size={props.lines === 3 ? "3" : undefined} aria-current={props.current ? "true" : undefined}>
          {body()}
        </a>
      </Show>
    </li>
  );
}

/** One text line inside a row: 20 px, or 16 px meta. */
export function RowLine(props: ParentProps<{ meta?: boolean }>) {
  return (
    <div class="k2-row__line" data-meta={props.meta ? "" : undefined}>
      {props.children}
    </div>
  );
}

// ── Table ─────────────────────────────────────────────────────────────────────────────────────────────────────────
export type TableColumn<T> = { label: string; width?: string; align?: "end"; cell: (row: T) => JSX.Element };

export function Table<T>(props: { label: string; columns: TableColumn<T>[]; rows: T[] }) {
  return (
    <table class="k2-table" aria-label={props.label}>
      <colgroup>
        <For each={props.columns}>{(column) => <col style={{ width: column.width }} />}</For>
      </colgroup>
      <thead>
        <tr>
          <For each={props.columns}>{(column) => <th data-align={column.align}>{column.label}</th>}</For>
        </tr>
      </thead>
      <tbody>
        <For each={props.rows}>
          {(row) => (
            <tr>
              <For each={props.columns}>{(column) => <td data-align={column.align}>{column.cell(row)}</td>}</For>
            </tr>
          )}
        </For>
      </tbody>
    </table>
  );
}

// ── Section: a line above the head; the body owns the text edge, rows inside own their lines ──────────────────────
export function Section(props: ParentProps<{ title: string; count?: number; action?: JSX.Element; flush?: boolean }>) {
  return (
    <section class="k2-section" aria-label={props.title}>
      <header class="k2-section__head">
        <h3 class="k2-section__title">{props.title}</h3>
        <Show when={props.count !== undefined}>
          <span class="k2-section__n">{props.count}</span>
        </Show>
        <Show when={props.action}>
          <span class="k2-section__act">{props.action}</span>
        </Show>
      </header>
      <div class="k2-section__body" data-flush={props.flush ? "" : undefined}>
        {props.children}
      </div>
    </section>
  );
}

/** Label and value, each pair a 32 px value row. */
export function Facts(props: { items: [label: string, value: JSX.Element][] }) {
  return (
    <dl class="k2-facts">
      <For each={props.items}>
        {(item) => (
          <>
            <dt>{item[0]}</dt>
            <dd>{item[1]}</dd>
          </>
        )}
      </For>
    </dl>
  );
}

// ── Notice cell: something needs a person; the whole square cell carries the tint ─────────────────────────────────
export function Notice(props: { tone?: "bad" | "warn"; title: string; text?: string; action?: JSX.Element }) {
  return (
    <div class="k2-notice" data-tone={props.tone} role={props.tone === "bad" ? "alert" : "status"}>
      <Icon name="alert" />
      <span class="k2-notice__title">{props.title}</span>
      <Show when={props.text}>
        <span class="k2-notice__text">{props.text}</span>
      </Show>
      <Show when={props.action}>
        <span class="k2-notice__act">{props.action}</span>
      </Show>
    </div>
  );
}

// ── Controls ──────────────────────────────────────────────────────────────────────────────────────────────────────
type ButtonLook = { variant?: "primary" | "ghost"; size?: "sm"; iconOnly?: boolean; edge?: boolean };

/** The look of a button as attributes, so ui-sdk triggers (which render their own button) share it. */
export const buttonLook = (look: ButtonLook) => ({
  class: "k2-btn",
  "data-variant": look.variant,
  "data-size": look.size,
  "data-icon": look.iconOnly ? "" : undefined,
  "data-edge": look.edge ? "" : undefined,
});

/** A button or a link that looks like one. Without children it shows only its icon and `label` is its name. */
export function Button(
  props: ParentProps<Omit<ButtonLook, "iconOnly"> & { icon?: IconName; label?: string; href?: string; type?: "button" | "submit"; onClick?: (event: MouseEvent) => void }>,
) {
  const look = () => buttonLook({ ...props, iconOnly: !props.children });
  const name = () => (props.children ? undefined : props.label);
  const content = () => (
    <>
      <Show when={props.icon}>{(icon) => <Icon name={icon()} />}</Show>
      {props.children}
    </>
  );
  return (
    <Show
      when={props.href}
      fallback={
        <button {...look()} type={props.type ?? "button"} aria-label={name()} onClick={props.onClick}>
          {content()}
        </button>
      }
    >
      <a {...look()} href={props.href} aria-label={name()}>
        {content()}
      </a>
    </Show>
  );
}

export function Chip(props: ParentProps<{ tone?: "ok" | "warn" | "bad" | "app"; href?: string; current?: boolean }>) {
  return (
    <Show when={props.href} fallback={<span class="k2-chip" data-tone={props.tone}>{props.children}</span>}>
      <a class="k2-chip" data-filter="" href={props.href} aria-current={props.current ? "true" : undefined}>
        {props.children}
      </a>
    </Show>
  );
}

export function Avatar(props: { name: string; color?: string; size?: "lg" }) {
  const initials = () =>
    props.name
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => part[0])
      .join("")
      .toUpperCase();
  return (
    <span class="k2-avatar" data-size={props.size} style={{ "--c": props.color }} aria-hidden="true">
      {initials()}
    </span>
  );
}
