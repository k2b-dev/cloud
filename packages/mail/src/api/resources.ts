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
  // Routers with a collection path directly below /mailboxes come first: the resolver below would read
  // `preferences` or `deleted` as a mailbox ID and answer 404. Their mailbox routes resolve the ID inline.
  .route("/", mailboxPreferenceRoutes)
  .route("/", mailboxLifecycleRoutes)
  .use("/mailboxes/:mailboxId/*", resolveMailboxParam)
  .route("/", addressRoutes)
  .route("/", incomingAutomationRoutes)
  .route("/", localTagRoutes)
  .route("/", conversationAssignmentRoutes)
  .route("/", conversationReferenceRoutes)
  .route("/", automaticReplyRoutes)
  .route("/", remoteContentRoutes);
