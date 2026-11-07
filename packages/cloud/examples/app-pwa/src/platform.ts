import { createAppPwa } from "@k2b/cloud/app-pwa";
import { accounts, canUseApp } from "@k2b/cloud/services";
import { app, installable } from "./config";
import { APP_ID, DEVICE_PAGE_SIZE, REQUEST_BYTES, RESPONSE_BYTES, SUBJECT_ID } from "./constants";
import { commands, queries, SubjectSchema } from "./domain";

export function createExamplePwa(publicOrigin: string) {
  return createAppPwa({
    app: { id: APP_ID, installable },
    publicOrigin,
    schema: "visit_demo",
    subject: SubjectSchema,
    budgets: { requestBytes: REQUEST_BYTES, responseBytes: RESPONSE_BYTES, listPageSize: DEVICE_PAGE_SIZE, maxAccessIds: 1 },
    authorizeStaff: async (action, signIn, tx) => {
      // The platform already locked and validated this exact web session family.
      // Resolve the real user; never manufacture roles or an employee actor from
      // an iPad credential. App grants are read using the supplied transaction.
      const user = await accounts.users.get({ id: signIn.userId }, { db: tx });
      if (
        !user ||
        !(await canUseApp(
          { actor: { kind: "user", user }, accessSubject: { type: "user", userId: user.id }, credentialKind: "session", scopes: [] },
          app.meta,
          { db: tx },
        ))
      )
        return false;
      switch (action) {
        // Shared devices outlive one person's work and unregistering one ends someone
        // else's use: only administrators register and unregister them here.
        case "register-device":
        case "revoke-registration":
        case "rename-registration":
          return user.roles.includes("admin");
        // Every app user may see the shared devices and take one over at the desk with
        // the code it shows. A real app can narrow this per registration through `target`.
        case "list-registrations":
        case "take-over-device":
        // Own devices and visits are checked by ownership in the platform.
        case "issue-device":
        case "list-devices":
        case "device-status":
        case "revoke-device":
        case "issue-visit":
        case "revoke-visit":
          return true;
      }
    },
    authorizeVisit: async (_signIn, value, tx) => {
      const subject = SubjectSchema.safeParse(value);
      if (!subject.success || subject.data.customerId !== SUBJECT_ID) return false;
      const [customer] = await tx`SELECT id FROM visit_demo.customers WHERE id = ${subject.data.customerId}::uuid FOR SHARE`;
      return Boolean(customer);
    },
    coreQueries: ["address.autocomplete"],
    queries,
    commands,
  });
}
export type ExamplePwa = ReturnType<typeof createExamplePwa>;
