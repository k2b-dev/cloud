import { isIP } from "node:net";
import { defineEnv } from "@k2b/cloud/config";
import { z } from "zod";

const budget = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const appEnv = defineEnv({
  NOTES_PUBLIC_ORIGIN: {
    schema: z.url().refine((value) => {
      const url = new URL(value);
      return (
        url.origin === value &&
        (url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
      );
    }, "must be an HTTPS origin without a path (loopback HTTP is allowed for development)"),
    required: true,
    doc: "Notes only: public website origin used for WebSocket, mutation, and administrator origin checks.",
  },
  NOTES_ADMIN_PASSWORD_HASH: {
    schema: z.string().startsWith("$argon2id$").max(1024),
    scope: "secret",
    doc: "Notes only: Argon2id operator password hash generated with Bun.password.hash; changing it invalidates all administrator sessions.",
  },
  NOTES_TRUSTED_PROXY: {
    schema: z.string().refine((value) => isIP(value) !== 0, "must be one exact IP address"),
    doc: "Notes only: immediate proxy address allowed to supply the last X-Forwarded-For entry; unset trusts no forwarding header.",
  },
  NOTES_STORAGE_BYTES: {
    schema: budget,
    required: true,
    doc: "Notes only: total reserved application storage budget in bytes; new notes and files pause at 90 percent and existing updates stop at capacity.",
  },
  NOTES_MAX_CONNECTIONS: {
    schema: budget,
    required: true,
    doc: "Notes only: maximum simultaneous WebSockets in this single process, selected from the pre-launch load test.",
  },
  NOTES_MAX_OPEN_PADS: {
    schema: budget,
    required: true,
    doc: "Notes only: maximum documents held in memory at once, selected from the pre-launch load test.",
  },
});
