import { approveInModal } from "../CapabilityApproval";
import { artifactClient } from "../client";
import type { Confirm } from "../html/host";
import { runHttp } from "../http-host";
import { browserHttpHost } from "../SecretsDialog";
import { runCapability } from "./capabilities";
import type { RuntimeServices } from "./services";
import { sharedStorage } from "./shared-storage";

/** Server access of a saved app the viewer may use. Loaded only for an authorized run; every endpoint rechecks access. */
export function browserServerOptions(id: string, confirm: Confirm): RuntimeServices {
  return {
    ai: (request, signal) => artifactClient.ai(request, { resourceId: id }, signal),
    capability: (name, input, signal) =>
      runCapability(
        name,
        input,
        { artifactId: id },
        (request, signal) =>
          confirm(
            () => approveInModal(request, signal),
            (decision) => decision.approved,
          ),
        signal,
      ),
    http: (request, signal) =>
      runHttp(
        request,
        { resourceId: id },
        {
          ...browserHttpHost,
          approve: (review, signal) =>
            confirm(
              () => browserHttpHost.approve(review, signal),
              (approved) => approved,
            ),
        },
        signal,
      ),
    pdf: (request, signal) => artifactClient.pdf(request, { resourceId: id }, signal),
    database: (request, signal) => artifactClient.database(id, request, undefined, signal),
    storage: (request) => sharedStorage(id, request),
  };
}
