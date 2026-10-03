import { Hono } from "hono";
import addressRoutes from "./addresses";
import automaticReplyRoutes from "./automatic-replies";
import conversationAssignmentRoutes from "./conversation-assignment";
import conversationReferenceRoutes from "./conversation-references";
import incomingAutomationRoutes from "./incoming-automations";
import localTagRoutes from "./local-tags";
import mailboxLifecycleRoutes from "./mailbox-lifecycle";
import mailboxPreferenceRoutes from "./mailbox-preferences";
import { type MailApiContext, resolveMailboxParam } from "./public-resource-boundary";
import remoteContentRoutes from "./remote-content";

export default new Hono<MailApiContext>()
  // The resolver below also matches `/mailboxes/preferences` and would answer 404 for it.
  .route("/", mailboxPreferenceRoutes)
  .use("/mailboxes/:mailboxId/*", resolveMailboxParam)
  .route("/", addressRoutes)
  .route("/", incomingAutomationRoutes)
  .route("/", localTagRoutes)
  .route("/", conversationAssignmentRoutes)
  .route("/", conversationReferenceRoutes)
  .route("/", automaticReplyRoutes)
  .route("/", remoteContentRoutes)
  .route("/", mailboxLifecycleRoutes);
