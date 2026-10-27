import { z } from "zod";
import { defineCapabilities } from "../contracts/capabilities";
import { appEvents, bindAppEvents } from "./app-events";

export const coreUserEventTypes = {
  user: { title: "User", description: "A Cloud user identity.", icon: "ti ti-user" },
} as const;
export const coreUserEvents = {
  "user.created": {
    version: 1,
    title: "User created",
    description: "A user identity was first created in Cloud.",
    subject: "user",
    schema: z.object({ userId: z.uuid(), provider: z.enum(["local", "ipa"]) }).strict(),
  },
} as const;
const declarations = defineCapabilities({ protocolVersion: 2, types: coreUserEventTypes, events: coreUserEvents });
const publisher = appEvents(declarations);

/** Creation services explicitly bind Core's shared event declarations before publishing. */
export const coreUserEventPublisher = () => {
  bindAppEvents("core", declarations);
  return publisher;
};
