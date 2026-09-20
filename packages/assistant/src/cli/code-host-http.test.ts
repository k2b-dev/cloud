import { expect, test } from "bun:test";
import { createCodeHostHttp, HOST_HEADER } from "./code-host-http";

test("loopback transport rejects unauthenticated, foreign paths and redirects", async () => {
  let calls = 0;
  const bridge = createCodeHostHttp({
    fetch: async () => {
      calls++;
      return Response.redirect("https://example.invalid/");
    },
  });
  try {
    expect((await fetch(bridge.origin + "/api/assistant/artifacts/test")).status).toBe(403);
    expect((await fetch(bridge.origin + "/other", { headers: { [HOST_HEADER]: bridge.token } })).status).toBe(403);
    expect(calls).toBe(0);
    const response = await fetch(bridge.origin + "/api/assistant/artifacts/test", { headers: { [HOST_HEADER]: bridge.token } });
    expect(response.status).toBe(502);
    expect(response.headers.get("location")).toBeNull();
  } finally {
    bridge.close();
  }
});

test("loopback backpressure bounds outstanding transfers and close aborts upstream", async () => {
  let pulls = 0,
    cancelled = 0;
  const bridge = createCodeHostHttp({
    fetch: async (_path, init) => {
      init?.signal?.addEventListener("abort", () => cancelled++, { once: true });
      return new Response(
        new ReadableStream({
          pull(controller) {
            pulls++;
            controller.enqueue(new Uint8Array(65536));
          },
        }),
      );
    },
  });
  const responses: Response[] = [];
  try {
    for (let i = 0; i < 8; i++)
      responses.push(await fetch(bridge.origin + "/api/assistant/artifacts/test", { headers: { [HOST_HEADER]: bridge.token } }));
    expect((await fetch(bridge.origin + "/api/assistant/artifacts/test", { headers: { [HOST_HEADER]: bridge.token } })).status).toBe(409);
    await Bun.sleep(50);
    // Unlimited upstream would run forever without backpressure; socket buffering is bounded.
    expect(pulls).toBeLessThan(2000);
    bridge.close();
    expect(cancelled).toBe(8);
  } finally {
    bridge.close();
    await Promise.all(responses.map((r) => r.body?.cancel().catch(() => {})));
  }
});
