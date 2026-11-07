import { Hono } from "hono";
import { sessionOriginGuard } from "../../packages/cloud/src/server/middleware/session-origin";

/** Put the production boundary before synthetic browser handlers, retaining the native request for sockets. */
export const checkFixtureSessionOrigin = async (request: Request): Promise<Response | undefined> => {
  const origin = new URL(request.url).origin;
  const probe = new Hono()
    .use(
      "*",
      sessionOriginGuard([], async () => origin),
    )
    .all("*", (c) => c.body(null, 204));
  const response = await probe.fetch(request);
  return response.status === 204 ? undefined : response;
};
