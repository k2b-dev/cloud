import { browserHttpHost } from "../SecretsDialog";
import { runHttp } from "../http-host";
import { approveInModal } from "../CapabilityApproval";
import { runCapability } from "./capabilities";
import { artifactClient } from "../client";
import type { SessionOptions } from "./session";

/** Loaded only for an explicitly authorized app run. Every endpoint rechecks access. */
export function browserServerOptions(id: string): Pick<SessionOptions, "ai" | "capability" | "http" | "pdf" | "database"> {
  return {
    ai: (request, signal) => artifactClient.ai(request, { resourceId: id }, signal),
    capability: (name, input, signal) => runCapability(name, input, { artifactId: id }, approveInModal, signal),
    http: (request, signal) => runHttp(request, { resourceId: id }, browserHttpHost, signal),
    pdf: (request, signal) => artifactClient.pdf(request, { resourceId: id }, signal),
    database: (request, signal) => artifactClient.database(id, request, undefined, signal),
  };
}
