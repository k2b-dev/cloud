import { coreClient } from "@k2b/cloud/clients/core";
import { type ApprovalPage, ApprovalPageSchema } from "@k2b/cloud/contracts/approvals";
import {
  type AiOpenQuestion,
  type AiOpenQuestions,
  type AiOpenQuestionsCursor,
  AiOpenQuestionsSchema,
} from "@k2b/cloud/contracts/open-questions";
import { type Accessor, createEffect, createMemo, on, onCleanup, type Setter } from "solid-js";
import type { AssistantApprovalsViewProps } from "./frontend/AssistantApprovalsView";
import { browserCodeInvoke } from "./frontend/code-client";
import { loadWaitingAutomations, type WaitingAutomation } from "./waiting-automations";

export type WaitingQuestionsPagingState = {
  items: AiOpenQuestion[];
  cursor?: AiOpenQuestionsCursor;
  loading?: boolean;
  failed?: boolean;
};

type WaitingCollections = {
  approvals: Accessor<ApprovalPage | null | undefined>;
  setApprovals: Setter<ApprovalPage | null | undefined>;
  automations: Accessor<readonly WaitingAutomation[] | null | undefined>;
  setAutomations: Setter<readonly WaitingAutomation[] | null | undefined>;
  paging: Accessor<WaitingQuestionsPagingState>;
  setPaging: Setter<WaitingQuestionsPagingState>;
};

const loadApprovalPage = async (): Promise<ApprovalPage> => {
  const response = await coreClient.approvals.$get({ query: { app: "assistant" } });
  if (!response.ok) throw new Error(`Approvals answered ${response.status}`);
  return ApprovalPageSchema.parse(await response.json());
};

export type WaitingQuestionsController = ReturnType<typeof connectWaitingQuestions>;

/** Reads and live refreshes load when the waiting page opens; SSR keeps its authorized first snapshot. */
export function connectWaitingQuestions(
  props: AssistantApprovalsViewProps,
  state: WaitingCollections,
  initialQuestions: readonly AiOpenQuestion[],
  initialPage: AiOpenQuestions | undefined,
) {
  const { approvals, setApprovals, automations, setAutomations, paging, setPaging } = state;
  let pageController = new AbortController();
  onCleanup(() => pageController.abort());
  let previousPage = initialPage;
  createEffect(
    on(
      () => props.questionsPage?.(),
      (page) => {
        if (page === previousPage) return;
        previousPage = page;
        pageController.abort();
        pageController = new AbortController();
        setPaging({ items: [], cursor: page?.nextCursor });
      },
    ),
  );
  const loadMore = async () => {
    const current = paging();
    if (!current.cursor) return;
    const signal = pageController.signal;
    try {
      const result = await browserCodeInvoke(
        {
          appId: "core",
          capabilityId: "ai.open_questions",
          kind: "query",
          input: { timeZone: props.timeZone, cursor: current.cursor },
          signal,
        },
        AiOpenQuestionsSchema,
      );
      if (signal.aborted) return;
      if (!result.ok) {
        setPaging({ ...current, loading: false, failed: true });
        return;
      }
      const page = result.data.data;
      setPaging({
        items: [...new Map([...current.items, ...page.items].map((item) => [item.id, item])).values()],
        cursor: page.nextCursor,
      });
    } catch {
      if (!signal.aborted) setPaging({ ...current, loading: false, failed: true });
    }
  };
  const loadApprovals = async () => {
    setApprovals(undefined);
    try {
      showApprovals(await loadApprovalPage());
    } catch {
      setApprovals(null);
    }
  };
  const readAutomations = async () => loadWaitingAutomations(browserCodeInvoke, props.timeZone);
  const loadAutomations = async () => {
    setAutomations(undefined);
    try {
      setAutomations(await readAutomations());
    } catch {
      setAutomations(null);
    }
  };
  // Approvals and automations have reads of their own; the row's list says when theirs changed. Both read again in
  // place, without a loading state, and a failed read keeps what the page shows.
  // Approvals read again only for a request the page has not seen yet. A request that leaves the list, such as one
  // decided here, keeps its card as a receipt until the next real load, so nothing moves under the person's click.
  const seenApprovals = new Set<string>();
  const showApprovals = (page: ApprovalPage | null | undefined) => {
    for (const item of page?.items ?? []) seenApprovals.add(item.id);
    setApprovals(page);
  };
  const approvalIds = createMemo(
    () =>
      props
        .questions()
        .filter((question) => question.kind === "approval")
        .map((question) => question.id),
    [],
    { equals: (a, b) => a.length === b.length && a.every((id, index) => id === b[index]) },
  );
  for (const question of initialQuestions) if (question.kind === "approval") seenApprovals.add(question.id);
  for (const item of props.initial?.items ?? []) seenApprovals.add(item.id);
  let approvalRead = 0;
  createEffect(
    on(approvalIds, (ids) => {
      const fresh = ids.filter((id) => !seenApprovals.has(id));
      if (fresh.length === 0) return;
      for (const id of fresh) seenApprovals.add(id);
      const request = ++approvalRead;
      loadApprovalPage().then(
        (page) => {
          if (request === approvalRead && approvals() !== undefined) showApprovals(page);
        },
        () => {},
      );
    }),
  );
  // Automations read again on any change of theirs: their rows carry no decision of their own.
  const automationKey = createMemo(() =>
    props
      .questions()
      .filter((question) => question.kind === "code_attention")
      .map((question) => question.id)
      .sort()
      .join(" "),
  );
  let automationRead = 0;
  let previousAutomationKey = initialQuestions
    .filter((question) => question.kind === "code_attention")
    .map((question) => question.id)
    .sort()
    .join(" ");
  createEffect(
    on(automationKey, (key) => {
      if (key === previousAutomationKey) return;
      previousAutomationKey = key;
      if (automations() === undefined) return;
      const request = ++automationRead;
      readAutomations().then(
        (list) => {
          if (request === automationRead && automations() !== undefined) setAutomations(list);
        },
        () => {},
      );
    }),
  );
  if (props.initial === undefined) void loadApprovals();
  if (props.initialAutomations === undefined) void loadAutomations();
  const retry = () => {
    void loadApprovals();
    if (automations() === null) void loadAutomations();
  };

  const refreshAutomations = () =>
    readAutomations().then(
      (list) => {
        setAutomations(list);
      },
      () => {
        setAutomations(null);
      },
    );
  return { loadMore, retry, loadAutomations, refreshAutomations };
}
