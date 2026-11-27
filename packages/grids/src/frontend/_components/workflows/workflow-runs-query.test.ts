import { expect, test } from "bun:test";
import { runsListState, urlStateOf, workflowRunsQuery } from "./workflow-runs-query";
import { parseWorkflowUrlState } from "./workflow-url-state";

test('the runs\' filters keep their old parameter names and "all" is no statement', () => {
  const query = workflowRunsQuery("de");
  const page = parseWorkflowUrlState(new URLSearchParams("status=failed&channel=api&window=7d&run=RUN1"));
  const state = runsListState(query, page);
  expect(state.filters).toEqual({ status: "failed", channel: "api" });
  // the declaration writes the same parameters and leaves the page's own (window, run) to the page
  expect(query.serialize(state).toString()).toBe("status=failed&channel=api");
  expect(urlStateOf(query.reset(), page)).toEqual({ window: "7d", status: "all", channel: "all" });
  expect(runsListState(query, { window: "24h", status: "all", channel: "all" }).filters).toEqual({});
});
