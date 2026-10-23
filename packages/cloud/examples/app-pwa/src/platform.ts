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
    authorizeStaff: async (_action, signIn, tx) => {
      // The platform already locked and validated this exact web session family.
      // Resolve the real user; never manufacture roles or an employee actor from
      // an iPad credential. App grants are read using the supplied transaction.
      const user = await accounts.users.get({ id: signIn.userId });
      return Boolean(
        user &&
          (await canUseApp(
            { actor: { kind: "user", user }, accessSubject: { type: "user", userId: user.id }, credentialKind: "session", scopes: [] },
            app.meta,
            { db: tx },
          )),
      );
    },
    authorizeVisit: async (_signIn, value, tx) => {
      const subject = SubjectSchema.safeParse(value);
      if (!subject.success || subject.data.customerId !== SUBJECT_ID) return false;
      const [customer] = await tx`SELECT id FROM visit_demo.customers WHERE id = ${subject.data.customerId}::uuid FOR SHARE`;
      return Boolean(customer);
    },
    queries,
    commands,
  });
}
export type ExamplePwa = ReturnType<typeof createExamplePwa>;
