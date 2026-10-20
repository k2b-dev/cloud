import { Button, NoticeCard, Placeholder, prefersReducedMotion, useLocale } from "@k2b/ui";
import { createEffect, createSignal, onCleanup, onMount, Show } from "solid-js";
import type { HelpDocumentPayload } from "../shared/help";
import { helpMessages } from "./help-messages";
import { panelElement } from "./layout-help-panel-lifecycle";
import { helpPanelModules } from "./layout-help-panel-modules";
import { type HelpPanelState, helpPanelState } from "./layout-help-panel-state";
import type { HelpTopic } from "./layout-help-registry";
import { helpLinkTarget } from "./layout-help-url";
import { HelpArticleView } from "./layout-help-views";
import { panelIdle } from "./panel-idle";

export default function HelpPanelArticle(props: { topic?: HelpTopic }) {
  const locale = useLocale();
  const t = () => helpMessages.resolve([locale()]).t;
  const [state, setState] = createSignal<HelpPanelState>();
  const [reader, setReader] = createSignal<typeof import("./layout-help-panel-reader")>();
  const [payload, setPayload] = createSignal<HelpDocumentPayload | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [reloadRequired, setReloadRequired] = createSignal(false);
  const [attempt, setAttempt] = createSignal(0);
  let pending: Promise<typeof import("./layout-help-panel-reader")> | undefined;
  let disposed = false;
  let sectionPressed = false;
  let queuedSection: { trigger: HTMLButtonElement; key: string } | undefined;
  const sections = new Map<Element, () => void>();
  const load = () =>
    (pending ??= helpPanelModules
      .reader()
      .then((module) => {
        if (!disposed) setReader(module);
        return module;
      })
      .catch((error: unknown) => {
        pending = undefined;
        throw error;
      }));
  const warm = () => {
    void load().catch(() => {});
  };
  const topic = () => (state() ? state()?.data.documents.find((topic) => topic.id === state()?.activeId()) : props.topic);
  const clientVisible = () =>
    state() ? state()?.view() === "article" && state()?.activeId() !== state()?.data.article?.id : !!props.topic;
  const scrollToHash = (hash: string) => {
    const current = state();
    const heading = Array.from(
      current?.root.querySelectorAll<HTMLElement>(
        "article:not([hidden]) h1[id], article:not([hidden]) h2[id], article:not([hidden]) h3[id], article:not([hidden]) h4[id], article:not([hidden]) h5[id], article:not([hidden]) h6[id]",
      ) ?? [],
    ).find((element) => element.id === hash);
    if (!heading) return false;
    for (let details = heading.closest("details"); details; details = details.parentElement?.closest("details") ?? null)
      details.open = true;
    heading.scrollIntoView({ block: "start", behavior: prefersReducedMotion() ? "auto" : "smooth" });
    return true;
  };
  onMount(() => {
    const current = helpPanelState(panelElement());
    setState(current);
    const upgrade = (trigger: HTMLButtonElement, key: string) => {
      // Safari keeps focus where it was when a button is clicked; only a focus move after the activation cancels it.
      const start = document.activeElement;
      void load()
        .then((module) => {
          if (disposed || !trigger.isConnected) return;
          // A pending chunk must not replace the trigger between pointerdown and pointerup.
          if (sectionPressed) {
            queuedSection = { trigger, key };
            return;
          }
          const container = trigger.parentElement;
          if (!container || sections.has(container)) return;
          const focused = document.activeElement === trigger;
          if (!focused && document.activeElement !== start && document.activeElement !== document.body) return;
          setError(null);
          sections.set(
            container,
            module.mountPanelSections(container, { locale: locale(), state: current, key, focused, onSection: scrollToHash }),
          );
        })
        .catch((reason: unknown) => {
          if (!disposed) {
            setReloadRequired(true);
            setError(reason instanceof Error ? reason.message : t().loadFallback);
            trigger.title = t().loadFailed + ": " + t().reload;
          }
        });
    };
    const click = (event: MouseEvent) => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey ||
        !(event.target instanceof Element)
      )
        return;
      const sectionTrigger = event.target.closest<HTMLButtonElement>("[data-help-sections]");
      if (sectionTrigger) {
        event.preventDefault();
        event.stopPropagation();
        upgrade(sectionTrigger, "ArrowDown");
        return;
      }
      const button = event.target.closest<HTMLElement>("[data-help-topic]");
      if (button) {
        event.preventDefault();
        current.open(button.dataset.helpTopic ?? "");
        return;
      }
      if (event.target.closest("[data-help-unavailable] button")) {
        location.reload();
        return;
      }
      const anchor = event.target.closest<HTMLAnchorElement>(".help-article a[href]");
      if (!anchor || (anchor.target && anchor.target !== "_self") || anchor.hasAttribute("download")) return;
      const target = helpLinkTarget(anchor.getAttribute("href") ?? "", location.href, current.data);
      if (!target) return;
      if (target.kind === "section") {
        if (scrollToHash(target.hash)) event.preventDefault();
      } else if (target.topicId === null) {
        event.preventDefault();
        current.changeQuery("");
        current.back();
        const input = current.root.querySelector<HTMLInputElement>("[data-help-search]");
        if (input) input.value = "";
      } else if (current.data.documents.some((topic) => topic.id === target.topicId)) {
        event.preventDefault();
        current.open(target.topicId, target.hash);
      }
    };
    const endPress = () => {
      sectionPressed = false;
      const next = queuedSection;
      queuedSection = undefined;
      if (next) upgrade(next.trigger, next.key);
    };
    const cancelPress = () => {
      sectionPressed = false;
      queuedSection = undefined;
    };
    const intent = (event: Event) => {
      if (event.type === "pointerdown" && event.target instanceof Element && event.target.closest("[data-help-sections]"))
        sectionPressed = true;
      if (event.target instanceof Element && event.target.closest("[data-help-topic], .help-article a[href], [data-help-sections]")) warm();
    };
    const key = (event: KeyboardEvent) => {
      intent(event);
      const trigger = event.target instanceof Element ? event.target.closest<HTMLButtonElement>("[data-help-sections]") : null;
      if (event.defaultPrevented || !trigger || !["Enter", " ", "ArrowDown", "ArrowUp"].includes(event.key)) return;
      event.preventDefault();
      event.stopPropagation();
      upgrade(trigger, event.key);
    };
    window.addEventListener("pointerup", endPress);
    window.addEventListener("pointercancel", cancelPress);
    current.root.addEventListener("click", click);
    current.root.addEventListener("keydown", key);
    const intents = ["pointerover", "pointerdown", "focusin"] as const;
    for (const event of intents) current.root.addEventListener(event, intent);
    onCleanup(panelIdle(warm));
    onCleanup(() => {
      window.removeEventListener("pointerup", endPress);
      window.removeEventListener("pointercancel", cancelPress);
      current.root.removeEventListener("click", click);
      current.root.removeEventListener("keydown", key);
      for (const event of intents) current.root.removeEventListener(event, intent);
      for (const dispose of sections.values()) dispose();
    });
  });
  onCleanup(() => {
    disposed = true;
  });
  createEffect(() => {
    const current = state();
    const active = topic();
    attempt();
    setPayload(null);
    setError(null);
    setReloadRequired(false);
    if (!current || !active || !clientVisible()) return;
    const controller = new AbortController();
    let cancelled = false;
    const chunkFailed = (reason: unknown): never => {
      if (!cancelled) setReloadRequired(true);
      throw reason;
    };
    void Promise.all([
      load().catch(chunkFailed),
      helpPanelModules
        .document()
        .catch(chunkFailed)
        .then((module) => module.loadPanelDocument(current, active, controller.signal, t())),
    ])
      .then(([, document]) => {
        if (!cancelled) setPayload(document);
      })
      .catch((reason: unknown) => {
        if (!cancelled && !(reason instanceof DOMException && reason.name === "AbortError"))
          setError(reason instanceof Error ? reason.message : t().loadFallback);
      });
    onCleanup(() => {
      cancelled = true;
      controller.abort();
    });
  });
  /** The navigation whose heading focus and section jump are done; returning from search must not replay them. */
  let settled = 0;
  createEffect(() => {
    const current = state();
    const navigation = current?.navigation();
    // The loaded reader replaces the loading frame and its heading; follow it unless the reader moved focus elsewhere.
    const body = current?.activeId() === current?.data.article?.id || (!!payload() && !!reader());
    if (!current || !navigation?.version || navigation.version === settled || current.view() !== "article") return;
    const frame = requestAnimationFrame(() => {
      const focused = document.activeElement;
      if (!focused || focused === document.body || focused.matches(".help-article-title") || focused.closest("[hidden]"))
        current.focusHeading();
      if (!body) return;
      settled = navigation.version;
      if (navigation.hash) scrollToHash(navigation.hash);
    });
    onCleanup(() => cancelAnimationFrame(frame));
  });
  createEffect(() => {
    const current = state();
    const live = current?.root.querySelector("[data-help-announcement]");
    if (live) live.textContent = current?.announcement() ?? "";
  });
  return (
    <>
      <Show when={clientVisible() && topic()}>
        {(active) => (
          <article class="help-article" data-surface="panel">
            <Show
              when={payload() ? reader() : undefined}
              fallback={
                <HelpArticleView
                  surface="panel"
                  topic={active()}
                  parts={null}
                  document={null}
                  Markdown={() => null}
                  showTools={false}
                  sectionMenu={null}
                  copyButton={null}
                  loading={
                    <Show when={!error()}>
                      <div class="min-h-[24rem]">
                        <Placeholder state="loading" variant="panel" title={t().loading} />
                      </div>
                    </Show>
                  }
                  failure={
                    <Show when={error()}>
                      {(message) => (
                        <NoticeCard tone="danger" title={t().loadFailed} detail={message()}>
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => (reloadRequired() ? location.reload() : setAttempt((value) => value + 1))}
                          >
                            {reloadRequired() ? t().reload : t().tryAgain}
                          </Button>
                        </NoticeCard>
                      )}
                    </Show>
                  }
                  toc={null}
                  copyAction={null}
                  headingRef={() => {}}
                  contentRef={() => {}}
                  onBack={() => state()?.back()}
                />
              }
            >
              {(module) => {
                const Reader = module().HelpPanelReader;
                return (
                  <Show when={payload()}>
                    {(document) => {
                      const current = state();
                      return current && <Reader state={current} topic={active()} document={document()} onSection={scrollToHash} />;
                    }}
                  </Show>
                );
              }}
            </Show>
          </article>
        )}
      </Show>
      <Show when={state()?.activeId() === state()?.data.article?.id && error()}>
        {(message) => (
          <NoticeCard tone="danger" title={t().loadFailed} detail={message()}>
            <Button size="sm" variant="secondary" onClick={() => location.reload()}>
              {t().reload}
            </Button>
          </NoticeCard>
        )}
      </Show>
    </>
  );
}
