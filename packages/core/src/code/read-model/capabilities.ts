import { codeReadModelContracts } from "@k2b/cloud/contracts";
import { runCodeQuery } from "../queries";
import { codeSourceTabContract, loadCodeSourceTab } from "../source-tab";
import { loadCodeActivityReadModel } from "./activity";
import { loadCodeVersionReadModel } from "./load";
import { loadCodeRunReadModel } from "./run";

export const codeReadModelQueries = {
  "code.source.tab": {
    title: "Read source tab",
    description: "Enabled source, chosen diff and dated history. Editors only.",
    ...codeSourceTabContract,
    openWorld: false,
    run: (input, context) => runCodeQuery(context, (ctx) => loadCodeSourceTab(input, ctx)),
  },
  "code.run.words": {
    title: "Describe run",
    description: "Confirmed outcomes and failure reason. No private payloads.",
    ...codeReadModelContracts.run,
    openWorld: false,
    run: (input, context) => runCodeQuery(context, (ctx) => loadCodeRunReadModel(input, ctx)),
  },
  "code.activity.words": {
    title: "Describe activity",
    description: "Weekly effects, recent results and local-day timeline.",
    ...codeReadModelContracts.activity,
    openWorld: false,
    run: (input, context) => runCodeQuery(context, (ctx) => loadCodeActivityReadModel(input, ctx)),
  },
  "code.version.words": {
    title: "Describe version",
    description: "Localized facts and separate model text. Readable targets only.",
    ...codeReadModelContracts.version,
    openWorld: false,
    run: (input, context) => runCodeQuery(context, (ctx) => loadCodeVersionReadModel(input, ctx)),
  },
} satisfies import("@k2b/cloud/contracts").CapabilityDefinitions["queries"];
