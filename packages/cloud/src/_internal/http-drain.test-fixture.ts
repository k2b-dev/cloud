import { defineApp } from "./define-app";

const mode = process.argv[2];
const report = (event: string, details = {}) => console.log(JSON.stringify({ event, ...details }));
let finish: () => void = () => {};
const held = new Promise<void>((resolve) => {
  finish = resolve;
});
process.stdin.on("data", () => finish());
const app = defineApp({
  id: `drain-${mode}`,
  name: "Drain probe",
  icon: "box",
  description: "HTTP drain regression",
  baseUrl: "http://drain.test:3000",
  routes: ["/api/drain"],
});
const started = await app.start({
  fetch: async (request) => {
    report("in-flight");
    if (mode === "stream")
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("stream"));
            request.signal.addEventListener(
              "abort",
              () => {
                report("request-aborted");
                controller.close();
              },
              { once: true },
            );
          },
        }),
      );
    await held;
    await app.sync.ready();
    return new Response("completed-with-sync");
  },
  lifecycle: {
    stop: async () => {
      // HTTP admission and request cancellation precede the owning app's stop
      // hook, while shared dependencies remain available to that hook.
      const ready = await started.fetch(new Request("http://drain.test/_cloud/ready"));
      await app.sync.ready();
      report("stop-hook", { readiness: ready.status });
    },
  },
});
const server = Bun.serve({ ...started, port: 0, idleTimeout: 0 });
process.on("SIGTERM", () => {
  void Promise.resolve(started.fetch(new Request("http://drain.test/_cloud/ready"))).then((ready) =>
    report("stopping", { readiness: ready.status }),
  );
});
report("listening", { url: server.url.href });
