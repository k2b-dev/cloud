import { AdminWorkspace } from "@k2b/cloud/ssr/islands";
import { useLocale } from "@k2b/ui";
import { Bar, Button, Failed, Loading, type NavProps, Notice, Pane, Section, StatusRow } from "@k2b/ui/v2";
import { createSignal, For, Match, onCleanup, onMount, Switch } from "solid-js";
import { gatewayOpsMessages } from "../../../messages";
import { INFRA_HREF, InfrastructureTabs } from "../../_components/InfrastructureTabs";
import { KeyCells } from "../../_components/KeyCells";
import type { InfraSection, InfraSectionResult, InfrastructureBackend } from "../sections";

export type InfrastructureScreenProps = {
  nav: NavProps;
  sections: Record<InfrastructureBackend, InfraSectionResult>;
};

const BACKENDS: { key: InfrastructureBackend; title: string; icon: string; href: string }[] = [
  { key: "postgres", title: "Postgres", icon: "database", href: INFRA_HREF.postgres },
  { key: "valkey", title: "Valkey", icon: "database", href: INFRA_HREF.valkey },
  { key: "nats", title: "NATS", icon: "topology-star-3", href: INFRA_HREF.nats },
];
/** Notices one section shows; the rest wait one click away in the backend's area. */
const NOTICES_SHOWN = 2;

/**
 * The infrastructure record's overview: one section per backend with its key numbers and what needs attention. A
 * backend that missed the first picture's budget loads on its own in its section, once; it never holds the others back.
 */
export default function InfrastructureScreen(props: InfrastructureScreenProps) {
  const locale = useLocale();
  const t = () => gatewayOpsMessages.resolve([locale()]).t;
  const [sections, setSections] = createSignal(props.sections);
  const controllers = new Set<AbortController>();
  onCleanup(() => {
    for (const controller of controllers) controller.abort();
  });
  const load = async (backend: InfrastructureBackend) => {
    const controller = new AbortController();
    controllers.add(controller);
    setSections({ ...sections(), [backend]: { state: "pending" } });
    try {
      const response = await fetch(`/api/gateway/infrastructure/${backend}`, { signal: controller.signal });
      const body = (await response.json().catch(() => null)) as { section?: InfraSection; message?: string } | null;
      if (!response.ok || !body?.section) throw new Error(body?.message ?? t().unavailable);
      setSections({ ...sections(), [backend]: { state: "ready", section: body.section } });
    } catch (error) {
      if (!controller.signal.aborted)
        setSections({ ...sections(), [backend]: { state: "failed", message: error instanceof Error ? error.message : t().unavailable } });
    } finally {
      controllers.delete(controller);
    }
  };
  onMount(() => {
    for (const { key } of BACKENDS) if (props.sections[key].state === "pending") void load(key);
  });
  const attention = () =>
    BACKENDS.filter(({ key }) => {
      const result = sections()[key];
      return result.state === "failed" || (result.state === "ready" && result.section.status !== "ok");
    }).length;
  const stateWord = (result: InfraSectionResult) =>
    result.state === "pending"
      ? t().loadingShort
      : result.state === "failed"
        ? t().unavailable
        : result.section.status === "ok"
          ? t().healthy
          : t().needsReview;
  return (
    <AdminWorkspace
      nav={props.nav}
      head={
        <Bar
          start={<InfrastructureTabs current="overview" />}
          end={<Button variant="ghost" icon="refresh" label={t().refresh} title={t().refresh} href={INFRA_HREF.overview} />}
        />
      }
    >
      <Pane
        label={t().infrastructure}
        scrollKey="gateway-ops-infrastructure"
        status={
          <StatusRow
            lead={attention() === 0 ? t().infraAllClear : t().infraAttention({ count: attention() })}
            facts={BACKENDS.map(({ key, title }) => ({ before: title, value: stateWord(sections()[key]) }))}
          />
        }
      >
        <For each={BACKENDS}>
          {(backend) => {
            const result = () => sections()[backend.key];
            const ready = () => {
              const current = result();
              return current.state === "ready" ? current.section : null;
            };
            const failure = () => {
              const current = result();
              return current.state === "failed" ? current.message : "";
            };
            const notices = () => ready()?.notices ?? [];
            return (
              <Section
                icon={backend.icon}
                title={backend.title}
                summary={stateWord(result())}
                more={{
                  label:
                    notices().length > NOTICES_SHOWN
                      ? t().moreNotices({ name: backend.title, count: notices().length - NOTICES_SHOWN })
                      : t().openBackend({ name: backend.title }),
                  href: backend.href,
                }}
              >
                <Switch>
                  <Match when={result().state === "pending"}>
                    <Loading rows={2} lines={2} />
                  </Match>
                  <Match when={result().state === "failed"}>
                    <Failed text={`${t().unavailable}: ${failure()}`} onRetry={() => void load(backend.key)} />
                  </Match>
                  <Match when={ready()}>
                    {(section) => (
                      <>
                        <KeyCells cells={section().cells} />
                        <For each={section().notices.slice(0, NOTICES_SHOWN)}>
                          {(notice) => (
                            <Notice tone={notice.tone} title={notice.title}>
                              {notice.text}
                            </Notice>
                          )}
                        </For>
                      </>
                    )}
                  </Match>
                </Switch>
              </Section>
            );
          }}
        </For>
      </Pane>
    </AdminWorkspace>
  );
}
