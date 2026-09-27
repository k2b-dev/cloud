/**
 * Connections to the NATS test target.
 *
 * `CLOUD_TEST_NATS_SERVERS` names the servers and `CLOUD_TEST_NATS_CREDS_FILE`
 * the identity, the same `.creds` file the runtime reads as `NATS_CREDS_FILE`.
 * Locally, the development broker keeps application data in the DEV account,
 * which accepts connections without credentials, and bounds tests in the TEST
 * account (`packages/gateway-ops/scripts/dev-nats.ts`). A connection that
 * lands in DEV therefore means the test identity is missing, and it is
 * refused before a test can create streams there.
 */
import { readFileSync } from "node:fs";
import { type ConnectionOptions, connect, credsAuthenticator, type NatsConnection } from "@nats-io/transport-node";
import { readTestNatsCredsFile, readTestTarget } from "./test-infra-env";

/** The account of the development applications on the local broker. */
const developmentAccount = "DEV";

/**
 * Connects to the NATS test target with its credentials. Throws when the
 * target is not set or the connection lands in the development account.
 */
export const connectTestNats = async (options: Omit<ConnectionOptions, "servers" | "authenticator"> = {}): Promise<NatsConnection> => {
  const target = readTestTarget(process.env, "nats");
  if (!target) throw new Error("CLOUD_TEST_NATS_SERVERS is not set");
  const credsFile = readTestNatsCredsFile(process.env);
  const connection = await connect({
    ...options,
    servers: target.split(",").map((server) => server.trim()),
    ...(credsFile ? { authenticator: credsAuthenticator(readFileSync(credsFile)) } : {}),
  });
  try {
    const reply = await connection.request("$SYS.REQ.USER.INFO", "", { timeout: 5_000 });
    if (reply.json<{ data?: { account?: string } }>().data?.account === developmentAccount) {
      throw new Error(
        `The NATS test connection lands in the development account ${developmentAccount}. ` +
          "Set CLOUD_TEST_NATS_CREDS_FILE to the absolute path of .local/nats/test.creds so tests use the TEST account.",
      );
    }
  } catch (error) {
    await connection.close();
    throw error;
  }
  return connection;
};
