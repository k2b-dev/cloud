import type { InvocationAuthority } from "./invocation-token";

export const invocationAuthorityFromMandate = (authority: {
  mandateId: string;
  mandateRevision: number;
  subject: { type: "user" | "service_account"; id: string };
  workloadType: string;
  workloadId: string;
}): InvocationAuthority => ({
  sub: authority.subject.id,
  principal_type: authority.subject.type,
  access_subject_type: authority.subject.type,
  access_subject_id: authority.subject.id,
  credential_kind: "mandate",
  scopes: [],
  mandate_id: authority.mandateId,
  mandate_revision: authority.mandateRevision,
  workload_type: authority.workloadType,
  workload_id: authority.workloadId,
});
