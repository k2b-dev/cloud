import { codeReadModelContracts } from "@k2b/cloud/contracts";
import { runCodeQuery } from "../queries";
import { codeSourceTabContract, loadCodeSourceTab } from "../source-tab";
import { loadCodeActivityReadModel } from "./activity";
import { loadCodeVersionReadModel } from "./load";
import { loadCodeRunReadModel } from "./run";

export const codeReadModelQueries = {
  "code.source.tab": {
    title: "Read the Code tab",
    description: "Editors read the enabled version’s source, a chosen version difference and version dates in bounded pages.",
    ...codeSourceTabContract,
    openWorld: false,
    run: (input, context) => runCodeQuery(context, (ctx) => loadCodeSourceTab(input, ctx)),
  },
  "code.run.words": {
    title: "Read a Code run in words",
    description: "Read confirmed observations and a localized failure reason without private inputs or outputs.",
    ...codeReadModelContracts.run,
    openWorld: false,
    run: (input, context) => runCodeQuery(context, (ctx) => loadCodeRunReadModel(input, ctx)),
  },
  "code.activity.words": {
    title: "Read Code activity in words",
    description: "Read confirmed weekly action counts, recent results and the bounded timeline of a local day.",
    ...codeReadModelContracts.activity,
    openWorld: false,
    run: (input, context) => runCodeQuery(context, (ctx) => loadCodeActivityReadModel(input, ctx)),
  },
  "code.version.words": {
    title: "Read a Code version in words",
    description: "Read localized checked facts and separately marked model text, with target names and links authorized for this caller.",
    ...codeReadModelContracts.version,
    openWorld: false,
    run: (input, context) => runCodeQuery(context, (ctx) => loadCodeVersionReadModel(input, ctx)),
  },
} satisfies import("@k2b/cloud/contracts").CapabilityDefinitions["queries"];
