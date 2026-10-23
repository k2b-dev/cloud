import { type ClientRequest, createServer, type IncomingMessage, type RequestListener, request } from "node:http";
import type { NetworkRequestFactory } from "../../packages/cloud/src/services/network-transport";

/** Local HTTP socket fixture, injected only after each transport's normal address validation. */
export const networkTransportFixture = async (handler: RequestListener) => {
  const server = createServer(handler);
  const disconnects: Promise<void>[] = [];
  server.on("connection", (socket) => {
    disconnects.push(new Promise<void>((resolve) => socket.once("close", () => resolve())));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected a TCP address");
  const requests: ClientRequest[] = [];
  const responses: IncomingMessage[] = [];
  const firstResponse = Promise.withResolvers<IncomingMessage>();
  const send: NetworkRequestFactory = (options, callback) => {
    const outgoing = request(
      { ...options, protocol: "http:", hostname: "127.0.0.1", port: address.port, lookup: undefined, agent: false },
      (incoming) => {
        responses.push(incoming);
        callback(incoming);
        firstResponse.resolve(incoming);
      },
    );
    requests.push(outgoing);
    return outgoing;
  };
  return {
    request: send,
    requests,
    responses,
    firstResponse: firstResponse.promise,
    disconnected: () => Promise.all(disconnects),
    async close() {
      for (const outgoing of requests) outgoing.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
};
