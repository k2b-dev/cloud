import { defineHelp } from "@k2b/cloud/server";
import incidentDe from "./documents/de/gateway-ops-incident.help.md" with { type: "text" };
import operationsDe from "./documents/de/gateway-ops-operations.help.md" with { type: "text" };
import referenceDe from "./documents/de/gateway-ops-reference.help.md" with { type: "text" };
import startDe from "./documents/de/gateway-ops-start.help.md" with { type: "text" };
import incident from "./documents/en/gateway-ops-incident.help.md" with { type: "text" };
import operations from "./documents/en/gateway-ops-operations.help.md" with { type: "text" };
import reference from "./documents/en/gateway-ops-reference.help.md" with { type: "text" };
import start from "./documents/en/gateway-ops-start.help.md" with { type: "text" };

export const gatewayOpsHelp = defineHelp({
  baseLocale: "en",
  documents: {
    en: [start, incident, operations, reference],
    de: [startDe, incidentDe, operationsDe, referenceDe],
  },
});
