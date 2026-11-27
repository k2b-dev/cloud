import type { RecentChange } from "../_area/RecentChanges";
import type { RegistryFormSection } from "../_area/RegistryForm";
import ApprovalsScreen from "./ApprovalsScreen.island";
import AutomationsScreen from "./AutomationsScreen.island";
import { CODE_LIMIT_KEYS, codeAreaSection } from "./area";
import type { CodeAreaData, CodeScreenBase } from "./data";
import { codeAdminMessages } from "./messages";
import NoAccessScreen from "./NoAccessScreen.island";
import OperationsScreen from "./OperationsScreen.island";
import PolicyScreen from "./PolicyScreen.island";

/** The limit settings in groups: what one run may use, the database, AI money, then the runner and submission sizes. */
export const codeLimitSections = (locale: string, keys: readonly string[]): RegistryFormSection[] => {
  const t = codeAdminMessages.resolve([locale]).t;
  const run = ["core.code.wall_clock_ms", "core.code.calls_per_run", "core.code.calls_per_second", "core.code.concurrency_per_code", "core.code.concurrency_per_owner"];
  const database = [
    "core.code.database_bytes",
    "core.code.database_owner_bytes",
    "core.code.database_unused_days",
    "core.code.rsql_url",
    "core.code.rsql_api_token",
    "core.code.rsql_allowed_targets",
  ];
  const ai = ["core.code.ai_budget_usd", "core.code.ai_daily_budget_usd", "core.code.ai_owner_daily_budget_usd"];
  const named = new Set([...run, ...database, ...ai, ...CODE_LIMIT_KEYS]);
  const runner = keys.filter((key) => !named.has(key) && /^core\.code\.(runner_|job_|event_|automatic_)/.test(key));
  const rest = keys.filter((key) => !named.has(key) && !runner.includes(key));
  return [
    { title: t.limitsRun, keys: run },
    { title: t.limitsDatabase, keys: database },
    { title: t.limitsAi, keys: ai },
    { title: t.limitsRunner, keys: runner },
    { title: t.limitsSubmission, keys: rest },
  ].filter((section) => section.keys.length);
};

export type CodeScreenProps = CodeScreenBase & {
  data: CodeAreaData | null;
  noPermission: boolean;
  /** The request locale, for the server-side grouping of the limits. */
  locale: string;
  /** The latest stored changes of the limits by a person, worded by the server. */
  recent?: RecentChange[];
};

/** The open section of Administration › Code as its island screen. */
export default function CodeScreen(props: CodeScreenProps) {
  const base = (): CodeScreenBase => ({
    nav: props.nav,
    query: props.query,
    dateConfig: props.dateConfig,
    viewerId: props.viewerId,
    apps: props.apps,
    documentationHref: props.documentationHref,
  });
  if (props.noPermission || !props.data) return <NoAccessScreen nav={props.nav} />;
  const data = props.data;
  const section = codeAreaSection(props.query);
  if (section === "approvals")
    return <ApprovalsScreen {...base()} summary={data.summary} approvals={data.approvals} decided={data.decided} approval={data.approval} />;
  if (section === "code") return <AutomationsScreen {...base()} summary={data.summary} codes={data.codes} code={data.code} reports={data.reports} />;
  if (section === "policy" || section === "groups" || section === "effective" || section === "history")
    return <PolicyScreen {...base()} section={section} policy={data.policy} effective={data.effective} history={data.history} />;
  return (
    <OperationsScreen
      {...base()}
      section={section}
      summary={data.summary}
      cleanup={data.cleanup}
      databases={data.databases}
      runners={data.runners}
      limits={data.limits}
      limitSections={codeLimitSections(props.locale, Array.isArray(data.limits) ? data.limits.map((entry) => entry.key) : [])}
      recent={props.recent}
    />
  );
}
