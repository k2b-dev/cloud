import { Scalar } from "@scalar/hono-api-reference";
import { getLocalizedRuntimeContext } from "@k2b/cloud/ssr";
import { Hono } from "hono";
import { apiDocsHelp } from "../help";
import { buildApiDocsGuideSource, buildScalarSources } from "../sources";

/**
 * Page router for the API Docs aggregator. Mounted at `/app/api-docs`.
 *
 * Scalar's hono middleware accepts a config-resolver function — we read
 * the runtime registry on every request and emit one `sources` entry per
 * app that opted in via `defineApp({ openapi: "..." })`. New apps appear
 * as soon as they heartbeat into the registry; removing an app drops them
 * out of the switcher on the next reload. No special cases: this file
 * maps registry entries into Scalar sources.
 */
const pages = new Hono().get(
  "/",
  Scalar(async (c) => {
    const runtime = getLocalizedRuntimeContext(c);
    const sources = [buildApiDocsGuideSource(apiDocsHelp.getMarkdown("api-docs-start") ?? ""), ...buildScalarSources(runtime.apps)];

    return {
      theme: "saturn",
      pageTitle: "Cloud API Docs",
      hideClientButton: true,
      sources,
    };
  }),
);

export default pages;
