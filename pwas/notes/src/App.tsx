import { createEffect, Match, on, onCleanup, onMount, Show, Switch } from "solid-js";
import { AdminPage } from "../admin/AdminPage";
import { isDark } from "./prefs";
import { linkClick, navigate, route } from "./router";
import { app, t } from "./state";
import { Icon } from "./ui/common";
import { finishPendingDeletes } from "./views/Delete";
import { usePageDrop } from "./views/Import";
import { Legal } from "./views/Legal";
import { handingOff, NotePage } from "./views/NotePage";
import { Overview } from "./views/Overview";
import { openPalette } from "./views/Palette";
import { SharedLink } from "./views/SharedLink";

export function App() {
  createEffect(() => {
    document.body.dataset.theme = isDark() ? "dark" : "light";
    const color = isDark() ? "#11151b" : "#ffffff";
    for (const meta of document.querySelectorAll('meta[name="theme-color"]')) {
      meta.removeAttribute("media");
      meta.setAttribute("content", color);
    }
  });

  const onKey = (event: KeyboardEvent) => {
    const target = event.target instanceof HTMLElement ? event.target : null;
    const typing = target?.isContentEditable || target?.tagName === "INPUT" || target?.tagName === "TEXTAREA";
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      openPalette();
    } else if (event.key === "/" && !typing && !document.querySelector("dialog[open]")) {
      event.preventDefault();
      openPalette();
    }
  };
  onMount(() => {
    document.addEventListener("click", linkClick);
    document.addEventListener("keydown", onKey);
    const online = () => void finishPendingDeletes();
    window.addEventListener("online", online);
    onCleanup(() => {
      document.removeEventListener("click", linkClick);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("online", online);
    });
  });
  // Only readiness and the network start a retry; the deletions themselves change the index.
  createEffect(
    on([app.ready, app.online], ([ready, online]) => {
      if (ready && online) void finishPendingDeletes();
    }),
  );

  const dragging = usePageDrop(() => route().name === "home" && app.records().length > 0);

  return (
    <>
      <Switch>
        <Match when={route().name === "home"}>
          <Show when={app.ready()} fallback={<Overview />}>
            <Show when={app.records().length > 0 && !handingOff()} fallback={<NotePage mode={{ kind: "draft" }} />}>
              <Overview />
            </Show>
          </Show>
        </Match>
        <Match
          when={(() => {
            const current = route();
            return current.name === "note" ? current : undefined;
          })()}
          keyed
        >
          {(current) => <NotePage mode={{ kind: "local", id: current.id }} />}
        </Match>
        <Match when={route().name === "admin"}>
          <AdminPage />
        </Match>
        <Match when={route().name === "example"}>
          <NotePage mode={{ kind: "example" }} />
        </Match>
        <Match
          when={(() => {
            const current = route();
            return current.name === "shared" ? current : undefined;
          })()}
          keyed
        >
          {(current) => <SharedLink linkId={current.linkId} />}
        </Match>
        <Match
          when={(() => {
            const current = route();
            return current.name === "legal" ? current : undefined;
          })()}
          keyed
        >
          {(current) => <Legal page={current.page} />}
        </Match>
        <Match when={route().name === "unknown"}>
          {(() => {
            navigate("/", { replace: true });
            return null;
          })()}
        </Match>
      </Switch>
      <Show when={dragging()}>
        <div class="n-dropover" aria-hidden="true">
          <Icon name="ti-file-upload" />
          <b>{t().dropTitle}</b>
          <span>{t().dropBody}</span>
        </div>
      </Show>
    </>
  );
}
