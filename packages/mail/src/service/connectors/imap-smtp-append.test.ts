import { describe, expect, spyOn, test } from "bun:test";
import { Readable, Writable } from "node:stream";
import { ImapFlow } from "imapflow";
import type { ProviderConnectionInput } from "../../contracts";
import { imapSmtpConnector, trackImapSession, withSharedImapSession } from "./imap-smtp";

// A public IP literal passes endpoint policy without DNS. connect/exec below
// replace transport only; APPEND, session postconditions and disposal stay real.
const config: ProviderConnectionInput = {
  name: "APPEND fixture",
  email: "append@example.test",
  username: "append@example.test",
  imap: { host: "93.184.216.34", port: 993, tlsMode: "implicit" },
  smtp: { host: "93.184.216.34", port: 465, tlsMode: "implicit" },
  secret: { kind: "password", password: "fixture" },
};
const internalDate = new Date("2026-10-22T12:00:00.000Z");

type Failure = "abort" | "session" | "disposal" | "connect" | "before-transfer" | "after-transfer";
const fixture = (failure: Failure, controller: AbortController) => {
  const error = new Error(`Fixture ${failure}`);
  const chunks: Buffer[] = [];
  let appended = false;
  const configure = (client: ImapFlow) => {
    Object.assign(client, {
      usable: true,
      writeSocket: new Writable({
        write(chunk, _encoding, callback) {
          chunks.push(Buffer.from(chunk));
          callback();
        },
      }),
      async logout() {
        if (failure === "disposal") throw error;
        client.usable = false;
      },
      close() {
        client.usable = false;
        if (failure === "disposal") throw error;
      },
      async exec(command: string, _attributes: unknown[], options: { onPlusTag(): Promise<void> }) {
        expect(command).toBe("APPEND");
        if (failure === "before-transfer") throw error;
        await options.onPlusTag();
        if (failure === "after-transfer") throw error;
        return {
          response: { attributes: [{ section: [{ value: "APPENDUID" }, { value: "42" }, { value: "7" }] }] },
          next() {
            appended = true;
            if (failure === "abort") controller.abort(error);
            if (failure === "session") client.emit("error", error);
          },
        };
      },
    });
  };
  const connect = spyOn(ImapFlow.prototype, "connect").mockImplementation(async function (this: ImapFlow) {
    if (failure === "connect") throw error;
    configure(this);
  });
  const append = (connection: ProviderConnectionInput) =>
    imapSmtpConnector.appendSource(
      connection,
      "Drafts",
      Readable.from([Buffer.from("body")]),
      4,
      ["\\Draft"],
      internalDate,
      controller.signal,
    );
  return {
    error,
    connect,
    append,
    get appended() {
      return appended;
    },
    get bytes() {
      return Buffer.concat(chunks).toString();
    },
  };
};

describe("APPEND effect evidence through real session wrappers", () => {
  for (const failure of ["abort", "session", "disposal", "connect", "before-transfer", "after-transfer"] as const) {
    test(`standalone session preserves effect evidence after ${failure}`, async () => {
      const controller = new AbortController();
      const transport = fixture(failure, controller);
      try {
        const rejected = await transport.append(config).catch((error: unknown) => error);
        expect(rejected).toBe(transport.error);
        expect(rejected).toMatchObject({ effectPossible: !["connect", "before-transfer"].includes(failure) });
        expect(transport.appended).toBe(["abort", "session", "disposal"].includes(failure));
        expect(transport.bytes).toBe(["connect", "before-transfer"].includes(failure) ? "" : "body\r\n");
      } finally {
        transport.connect.mockRestore();
      }
    });
  }

  for (const failure of ["abort", "session", "before-transfer", "after-transfer"] as const) {
    test(`shared session preserves effect evidence after ${failure}`, async () => {
      const controller = new AbortController();
      const transport = fixture(failure, controller);
      try {
        const rejected = await withSharedImapSession(
          config,
          async () =>
            trackImapSession(new ImapFlow({ host: "unused.example.test", auth: { user: "fixture", pass: "fixture" }, logger: false })),
          transport.append,
        ).catch((error: unknown) => error);
        expect(rejected).toBe(transport.error);
        expect(rejected).toMatchObject({ effectPossible: failure !== "before-transfer" });
        expect(transport.appended).toBe(["abort", "session"].includes(failure));
      } finally {
        transport.connect.mockRestore();
      }
    });
  }
});
