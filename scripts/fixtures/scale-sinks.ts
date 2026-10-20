/** SMTP and control endpoints for the disposable scale acceptance project. */
import { type SmtpDataReply, smtpSink } from "./smtp-sink";

let holding = false;
const held = new Set<SmtpDataReply>();
const sink = smtpSink({
  hostname: "0.0.0.0",
  port: 2525,
  hold: (_message, reply) => {
    if (!holding) return false;
    held.add(reply);
    return true;
  },
});
const release = () => {
  holding = false;
  // A held DATA body is deliberately unaccepted. Recovery must deliver it again.
  for (const reply of held) reply.drop();
  held.clear();
};
const server = Bun.serve({
  hostname: "0.0.0.0",
  port: 8025,
  fetch(request) {
    const path = new URL(request.url).pathname;
    if (request.method === "GET" && path === "/messages") return Response.json(sink.messages);
    if (request.method === "GET" && path === "/connections") return Response.json(sink.connectionLog);
    if (request.method === "POST") {
      if (path === "/hold") holding = true;
      else if (path === "/release") release();
      else if (path === "/reset") {
        release();
        sink.messages.length = 0;
        sink.connectionLog.length = 0;
      } else return new Response("Not found", { status: 404 });
      return Response.json({ holding });
    }
    return new Response("Not found", { status: 404 });
  },
});
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    release();
    sink.stop();
    void server.stop(true);
  });
