import type { Socket } from "bun";

export type SmtpSinkMessage = { from: string; to: string[]; raw: string };
export type SmtpSinkOptions = { reply?: (command: string, argument: string) => string | undefined };
type Session = { buffer: string; decoder: TextDecoder; from: string; to: string[]; lines: string[]; data: boolean; auth: number };

/** Ephemeral loopback-only SMTP server. Each connection owns its envelope and DATA state. */
export const smtpSink = (options: SmtpSinkOptions = {}) => {
  const messages: SmtpSinkMessage[] = [];
  const sockets = new Set<Socket<Session>>();
  const reset = (state: Session) => {
    state.from = "";
    state.to = [];
    state.lines = [];
    state.data = false;
    state.auth = 0;
  };
  const server = Bun.listen<Session>({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open(socket) {
        socket.data = { buffer: "", decoder: new TextDecoder(), from: "", to: [], lines: [], data: false, auth: 0 };
        sockets.add(socket);
        socket.write("220 localhost SMTP sink\r\n");
      },
      data(socket, bytes) {
        const state = socket.data;
        state.buffer += state.decoder.decode(bytes, { stream: true });
        for (let end = state.buffer.indexOf("\r\n"); end >= 0; end = state.buffer.indexOf("\r\n")) {
          const line = state.buffer.slice(0, end);
          state.buffer = state.buffer.slice(end + 2);
          if (state.data) {
            if (line !== ".") {
              state.lines.push(line.startsWith("..") ? line.slice(1) : line);
              continue;
            }
            const override = options.reply?.("MESSAGE", state.lines.join("\r\n"));
            const reply = override ?? "250 Message accepted";
            if (reply.startsWith("250")) messages.push({ from: state.from, to: [...state.to], raw: state.lines.join("\r\n") + "\r\n" });
            reset(state);
            socket.write(`${reply}\r\n`);
            continue;
          }
          if (state.auth) {
            state.auth--;
            socket.write(state.auth ? "334 UGFzc3dvcmQ6\r\n" : "235 Authentication successful\r\n");
            continue;
          }
          const [verb = "", ...rest] = line.split(" ");
          const command = verb.toUpperCase(),
            argument = rest.join(" ");
          const override = options.reply?.(command, argument);
          if (override !== undefined && /^[45]/.test(override)) {
            socket.write(`${override}\r\n`);
            continue;
          }
          const reply = (message: string) => socket.write(`${override ?? message}\r\n`);
          switch (command) {
            case "EHLO":
              reply("250-localhost\r\n250 AUTH PLAIN LOGIN");
              break;
            case "HELO":
            case "NOOP":
              reply("250 OK");
              break;
            case "AUTH": {
              const [mechanism, initial] = argument.split(" ");
              state.auth = mechanism?.toUpperCase() === "LOGIN" ? (initial ? 1 : 2) : initial ? 0 : 1;
              reply(state.auth ? "334 VXNlcm5hbWU6" : "235 Authentication successful");
              break;
            }
            case "MAIL":
              reset(state);
              state.from = argument.match(/^FROM:\s*<([^>]*)>/i)?.[1] ?? "";
              reply("250 OK");
              break;
            case "RCPT":
              state.to.push(argument.match(/^TO:\s*<([^>]*)>/i)?.[1] ?? "");
              reply("250 OK");
              break;
            case "DATA":
              state.data = true;
              reply("354 End with <CRLF>.<CRLF>");
              break;
            case "RSET":
              reset(state);
              reply("250 Reset");
              break;
            case "QUIT":
              socket.end(`${override ?? "221 Bye"}\r\n`);
              break;
            default:
              reply("502 Command not implemented");
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
    },
  });
  return {
    host: "127.0.0.1",
    port: server.port!,
    messages,
    stop() {
      for (const socket of sockets) socket.end();
      server.stop(true);
    },
  };
};
