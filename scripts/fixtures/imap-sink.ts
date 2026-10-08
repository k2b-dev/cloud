import type { Socket, SocketHandler } from "bun";
import { TEST_SERVER_CERT, TEST_SERVER_KEY } from "../../packages/cloud/src/server/services/freeipa/test-certificates.test-fixture";

export type ImapSinkMessage = { uid: number; bodyStructure: string; sections: Record<string, string> };
export type ImapSinkOptions = {
  messages?: ImapSinkMessage[];
  esearch?: boolean;
  starttls?: boolean;
  implicitTls?: boolean;
  uidNext?: number | null;
};
type Session = {
  buffer: string;
  decoder: TextDecoder;
  authTag?: string;
  authSteps: number;
  secure: boolean;
  pending: Buffer[];
  offset: number;
};

/** Scripted, ephemeral IMAP server. Never listens outside loopback or mutates mail. */
export const imapSink = (options: ImapSinkOptions = {}) => {
  const messages = [...(options.messages ?? [])].sort((a, b) => a.uid - b.uid);
  const commands: string[] = [];
  const sockets = new Set<Socket<Session>>();
  let largestResponse = 0;
  const certificates = { cert: TEST_SERVER_CERT, key: TEST_SERVER_KEY };
  const flush = (socket: Socket<Session>) => {
    const state = socket.data;
    while (state.pending.length) {
      const buffer = state.pending[0]!;
      const count = socket.write(buffer.subarray(state.offset));
      if (count <= 0) return;
      state.offset += count;
      if (state.offset < buffer.length) return;
      state.pending.shift();
      state.offset = 0;
    }
  };
  const send = (socket: Socket<Session>, response: string) => {
    const bytes = Buffer.from(response);
    largestResponse = Math.max(largestResponse, bytes.length);
    socket.data.pending.push(bytes);
    flush(socket);
  };
  const capability = (secure: boolean) =>
    [
      "IMAP4rev1",
      "AUTH=PLAIN",
      ...(options.esearch === false ? [] : ["ESEARCH"]),
      ...(options.starttls && !secure ? ["STARTTLS"] : []),
    ].join(" ");
  const handlers: SocketHandler<Session> = {
    open(socket) {
      socket.data = { buffer: "", decoder: new TextDecoder(), authSteps: 0, secure: options.implicitTls ?? false, pending: [], offset: 0 };
      sockets.add(socket);
      send(socket, `* OK [CAPABILITY ${capability(socket.data.secure)}] IMAP sink ready\r\n`);
    },
    drain: flush,
    data(socket, bytes) {
      const state = socket.data;
      state.buffer += state.decoder.decode(bytes, { stream: true });
      for (let end = state.buffer.indexOf("\r\n"); end >= 0; end = state.buffer.indexOf("\r\n")) {
        const line = state.buffer.slice(0, end);
        state.buffer = state.buffer.slice(end + 2);
        commands.push(line);
        if (state.authSteps) {
          state.authSteps--;
          send(socket, state.authSteps ? "+ UGFzc3dvcmQ6\r\n" : `${state.authTag} OK Authenticated\r\n`);
          continue;
        }
        const [tag = "", verb = ""] = line.split(" ");
        const ok = () => send(socket, `${tag} OK Completed\r\n`);
        switch (verb.toUpperCase()) {
          case "CAPABILITY":
            send(socket, `* CAPABILITY ${capability(state.secure)}\r\n`);
            ok();
            break;
          case "STARTTLS": {
            if (!options.starttls || state.secure) {
              send(socket, `${tag} BAD STARTTLS unavailable\r\n`);
              break;
            }
            ok();
            const [, tls] = socket.upgradeTLS<Session>({
              tls: certificates,
              data: { ...state, secure: true },
              socket: { ...handlers, open: undefined },
            });
            sockets.delete(socket);
            sockets.add(tls);
            return;
          }
          case "AUTHENTICATE":
            state.authTag = tag;
            state.authSteps = /AUTHENTICATE LOGIN/i.test(line) ? 2 : 1;
            send(socket, "+ \r\n");
            break;
          case "LOGIN":
            ok();
            break;
          case "LIST":
          case "LSUB":
            send(socket, `* ${verb.toUpperCase()} (\\Noselect) "/" ""\r\n`);
            ok();
            break;
          case "EXAMINE": {
            const uidNext = options.uidNext === undefined ? (messages.at(-1)?.uid ?? 0) + 1 : options.uidNext;
            send(
              socket,
              `* FLAGS (\\Seen)\r\n* ${messages.length} EXISTS\r\n* OK [UIDVALIDITY 42] Validity\r\n${uidNext === null ? "" : `* OK [UIDNEXT ${uidNext}] Next UID\r\n`}${tag} OK [READ-ONLY] Examined\r\n`,
            );
            break;
          }
          case "UID": {
            if (/^\S+ UID SEARCH /i.test(line)) {
              const range = line.match(/ UID (\d+):(\d+)/i);
              const low = Number(range?.[1]),
                high = Number(range?.[2]);
              const found = messages.filter((message) => message.uid >= low && message.uid <= high);
              if (/ RETURN \(MIN\)/i.test(line) && options.esearch !== false)
                send(socket, `* ESEARCH (TAG "${tag}") UID${found[0] ? ` MIN ${found[0].uid}` : ""}\r\n`);
              else send(socket, `* SEARCH${found.length ? ` ${found.map((message) => message.uid).join(" ")}` : ""}\r\n`);
              ok();
            } else if (/^\S+ UID FETCH /i.test(line)) {
              const uid = Number(line.match(/ UID FETCH (\d+)/i)?.[1]);
              const index = messages.findIndex((message) => message.uid === uid);
              const message = messages[index];
              if (message) {
                if (/BODYSTRUCTURE/i.test(line))
                  send(socket, `* ${index + 1} FETCH (UID ${uid} BODYSTRUCTURE ${message.bodyStructure})\r\n`);
                const peek = line.match(/BODY\.PEEK\[([^\]]+)\]<(\d+)\.(\d+)>/i);
                if (peek) {
                  const section = peek[1]!.toUpperCase(),
                    start = Number(peek[2]),
                    length = Number(peek[3]);
                  const content = Buffer.from(message.sections[section] ?? "").subarray(start, start + length);
                  send(
                    socket,
                    `* ${index + 1} FETCH (UID ${uid} BODY[${section}]<${start}> {${content.length}}\r\n${content.toString()} )\r\n`,
                  );
                }
              }
              ok();
            } else send(socket, `${tag} BAD Unsupported UID command\r\n`);
            break;
          }
          case "LOGOUT":
            send(socket, `* BYE Closing\r\n${tag} OK Logout\r\n`);
            socket.end();
            break;
          case "NOOP":
            ok();
            break;
          default:
            send(socket, `${tag} BAD Unsupported command\r\n`);
        }
      }
    },
    close(socket) {
      sockets.delete(socket);
    },
    error(socket) {
      sockets.delete(socket);
      socket.end();
    },
  };
  const server = Bun.listen<Session>({
    hostname: "127.0.0.1",
    port: 0,
    ...(options.implicitTls ? { tls: certificates } : {}),
    socket: handlers,
  });
  return {
    host: "127.0.0.1",
    port: server.port!,
    commands,
    get largestResponse() {
      return largestResponse;
    },
    stop() {
      for (const socket of sockets) socket.end();
      server.stop(true);
    },
  };
};
