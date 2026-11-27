import { coreClient } from "@k2b/cloud/clients/core";
import { AI_LOCAL_CLIENT_DEFAULT_INSTRUCTIONS, AI_PLATFORM_PROMPT_TEMPLATE, formatDurationMs, formatPercent } from "@k2b/cloud/shared";
import { Button, Cells, Chip, Dialog, Empty, type NavProps, Prose, Row, Section, StatusRow, Text, useLocale, useToast } from "@k2b/ui/v2";
import { createSignal, For, type JSX, Show } from "solid-js";
import AreaFrame from "../_area/AreaFrame";
import RecentChanges from "../_area/RecentChanges";
import RegistryForm from "../_area/RegistryForm";
import StateWord from "../_area/StateWord";
import { aiSettingsMessages } from "../settings/_components/ai-settings-messages";
import { aiAreaLink, aiSectionLabel } from "./frame";
import type { AiEnrichmentView, AiSettingsData } from "./settings-data";

type Messages = ReturnType<typeof aiSettingsMessages.resolve>["t"];
/** A built-in text the dialog shows: its words, and a heading for each part when a task has several. */
type Reading = { title: string; description: string; texts: { heading?: string; text: string }[] };

/** The enrichment of chats as it runs now: failures, error rate and run time, the latest runs, a run by hand. */
function EnrichmentState(props: { t: Messages; locale: string; enrichment: AiEnrichmentView; showJobsLink: boolean }) {
  const toast = useToast();
  const [running, setRunning] = createSignal(false);
  const t = () => props.t;
  const run = async () => {
    setRunning(true);
    try {
      const response = await coreClient.admin.core.settings["run-ai-enrichment"].$post();
      const body = (await response.json().catch(() => null)) as { ok?: boolean; message?: string } | null;
      if (!response.ok || !body?.ok) throw new Error(body?.message ?? t().enrichmentFailed);
      // The figures and runs above are the server's; the next load shows the run that just ended.
      window.location.reload();
    } catch (error) {
      toast(error instanceof Error ? error.message : t().enrichmentFailed, { status: "bad" });
      setRunning(false);
    }
  };
  const enrichment = () => props.enrichment;
  return (
    <>
      <Cells>
        <Cells.Cell
          icon="alert-circle"
          label={t().failedChats}
          value={
            enrichment().failedConversations > 0 ? (
              <Chip status="bad">{enrichment().failedConversations.toLocaleString(props.locale)}</Chip>
            ) : (
              enrichment().failedConversations.toLocaleString(props.locale)
            )
          }
          meta={t().activeChats({ shown: enrichment().totalConversations.toLocaleString(props.locale) })}
        />
        <Cells.Cell
          icon="percentage"
          label={t().errorRate24h}
          value={formatPercent(enrichment().errorRate24h / 100, { locale: props.locale })}
          meta={t().failedRuns({
            failed: enrichment().failedRuns24h.toLocaleString(props.locale),
            total: enrichment().totalRuns24h.toLocaleString(props.locale),
          })}
        />
        <Cells.Cell
          icon="clock"
          label={t().averageRuntime}
          value={formatDurationMs(enrichment().avgDurationMs, { locale: props.locale })}
          meta={enrichment().lastRun ? t().lastRun({ date: enrichment().lastRun ?? "" }) : undefined}
        />
      </Cells>
      <Section
        icon="sparkles"
        title={t().enrichmentState}
        count={enrichment().recentRuns.length || undefined}
        summary={t().enrichmentTraceHint}
        actions={[
          // k2b-ui gap: a section's action has no `busy`; while the run lasts it is disabled and the toast reports a failure
          { label: running() ? t().running : t().runNow, icon: "player-play", disabled: running(), onClick: () => void run() },
        ]}
        more={props.showJobsLink ? { label: t().openJobs, href: "/admin/observability/jobs?search=ai%3Achat", forward: true } : undefined}
      >
        <Show when={enrichment().recentRuns.length} fallback={<Empty icon="sparkles" text={t().noRuns} />}>
          <For each={enrichment().recentRuns}>
            {(entry) => (
              <Row
                icon={entry.status === "failed" ? "alert-circle" : "message-2"}
                lines={[
                  entry.conversationTitle || entry.conversationId,
                  `${entry.trigger === "manual" ? t().triggerManual : t().triggerScheduled} · ${entry.when}`,
                ]}
                time={formatDurationMs(entry.durationMs, { locale: props.locale })}
                end={
                  entry.status === "failed" ? (
                    <Chip status="bad">{t().runFailed}</Chip>
                  ) : (
                    <StateWord muted={entry.status === "skipped"}>{entry.status === "ok" ? t().runOk : t().runSkipped}</StateWord>
                  )
                }
              />
            )}
          </For>
        </Show>
      </Section>
    </>
  );
}

/**
 * General, Background jobs and Tools & API of the AI area on v2: the section's registry settings as `Setting` rows
 * with Discard and Save in the footer, the one statement that matters first, and beside them the built-in texts Cloud
 * sends before the instructions (each opens to read) and the latest changes by a person. Background jobs adds the
 * enrichment as it runs now, with a run by hand.
 */
export default function SettingsScreen(props: { nav: NavProps; data: AiSettingsData }) {
  const locale = useLocale();
  const t = () => aiSettingsMessages.resolve([locale()]).t;
  const [reading, setReading] = createSignal<Reading | null>(null);
  const entry = (key: string) => props.data.entries.find((item) => item.key === key);
  const keys = () => props.data.entries.map((item) => item.key);
  const enrichment = () => props.data.enrichment;

  // k2b-ui gap: Hero figure (#4360); the one statement stands as the lead of the status row until it lands.
  const hero = (): JSX.Element => {
    if (props.data.section === "general") return <StatusRow lead={entry("ai.enabled")?.value === true ? t().heroAiOn : t().heroAiOff} />;
    if (props.data.section === "tools") {
      const key = entry("ai.firecrawl_api_key");
      const search = key ? key.isCustom || key.valueSource === "env" : false;
      return (
        <StatusRow
          lead={entry("ai.openai_api_enabled")?.value === true ? t().heroApiOn : t().heroApiOff}
          facts={[{ after: search ? t().heroSearchOn : t().heroSearchOff }]}
        />
      );
    }
    const state = enrichment();
    if (!state) return undefined;
    return (
      <StatusRow
        lead={t().heroWaiting({ count: state.dirtyConversations, shown: state.dirtyConversations.toLocaleString(locale()) })}
        facts={state.dirtyConversations > 0 && state.oldestDirty ? [{ before: t().heroOldest, value: state.oldestDirty }] : []}
      />
    );
  };

  /** The built-in texts of this section: the platform prompt and the local clients' default, or the task prompts. */
  const texts = (): (Reading & { meta: string })[] => {
    if (props.data.section === "general")
      return [
        {
          title: t().platformPrompt,
          meta: t().platformPromptMeta,
          description: t().platformPromptDescription,
          texts: [{ text: AI_PLATFORM_PROMPT_TEMPLATE }],
        },
        {
          title: t().localClientDefault,
          meta: t().localClientDefaultMeta,
          description: t().localClientBuiltInDescription,
          texts: [{ text: AI_LOCAL_CLIENT_DEFAULT_INSTRUCTIONS }],
        },
      ];
    const prompts = props.data.prompts;
    if (props.data.section !== "jobs" || !prompts) return [];
    const task = (key: keyof typeof prompts, title: string, headings: string[] = []) => ({
      title,
      meta: t().promptMeta({ count: prompts[key].length }),
      description: t().builtInPromptsDescription,
      texts: prompts[key].map((text, index) => ({ heading: headings[index], text })),
    });
    return [
      task("ai.chat_enrichment_instructions", t().groupEnrichment),
      task("ai.memory_learning_instructions", t().groupPersonalization, [t().turnLearningPrompt, t().workflowLearningPrompt]),
      task("ai.compaction_instructions", t().groupCompaction),
    ];
  };

  const side = () => {
    const recent = props.data.recent;
    if (!texts().length && !recent.length) return undefined;
    return {
      label: t().sideLabel,
      content: (
        <>
          <Show when={texts().length}>
            <Section icon="file-text" title={t().builtInTexts} summary={t().builtInTextsSummary}>
              <For each={texts()}>{(item) => <Row icon="file-text" lines={[item.title, item.meta]} onOpen={() => setReading(item)} />}</For>
            </Section>
          </Show>
          <Show when={recent.length}>
            <RecentChanges items={recent} />
          </Show>
        </>
      ),
    };
  };

  return (
    <AreaFrame
      nav={props.nav}
      area={aiAreaLink(locale())}
      title={aiSectionLabel(locale(), props.data.section)}
      status={hero()}
      side={side()}
    >
      <Show when={enrichment()}>
        {(state) => <EnrichmentState t={t()} locale={locale()} enrichment={state()} showJobsLink={props.data.showJobsLink} />}
      </Show>
      <RegistryForm
        groups={["ai"]}
        sections={props.data.sections}
        entries={props.data.entries}
        // The AI fields carry the area's own words, which the settings API does not know (k2b gap, see the report): a
        // saved change reloads the page, so labels, the statement above and the latest changes stay the server's.
        reloadAfter={keys()}
      />
      <Dialog
        title={reading()?.title ?? ""}
        open={reading() !== null}
        onOpenChange={(open) => {
          if (!open) setReading(null);
        }}
        foot={<Button onClick={() => setReading(null)}>{t().close}</Button>}
      >
        <Show when={reading()}>
          {(current) => (
            <>
              <Text muted>{current().description}</Text>
              <For each={current().texts}>
                {(part) => (
                  <>
                    <Show when={part.heading}>
                      <Text weight="strong">{part.heading}</Text>
                    </Show>
                    {/* k2b-ui gap: no code block that wraps in v2; the built-in text reads as Markdown (Liquid tags stay text) */}
                    <Prose markdown={part.text} />
                  </>
                )}
              </For>
            </>
          )}
        </Show>
      </Dialog>
    </AreaFrame>
  );
}
