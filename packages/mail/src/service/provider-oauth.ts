import { randomBytes } from "node:crypto";
import { audit, coreSettings, decryptSecret, encryptSecret } from "@k2b/cloud/services";
import { err, fail, ok, type Result } from "@k2b/stdlib";
import { sql } from "bun";
import type {
  MailOAuthFlowResult,
  MailOAuthProviderId,
  MailOAuthStartInput,
  MailOAuthStartResult,
  ProviderConnectionDetails,
  ProviderSecret,
  ProviderTransportDiagnostics,
} from "../contracts";
import {
  mailOAuthStartInputSchema,
  providerConnectionDetailsSchema,
  providerSecretSchema,
  providerTransportDiagnosticsSchema,
} from "../contracts";
import { requireMailboxPermission } from "./access";
import { auditActorFromRequest, type MailRequestContext } from "./auth";
import * as bindings from "./bindings";
import { sha256Text } from "./canonical";
import { verifyImapSmtpTransports } from "./connectors/imap-smtp";
import * as providerConnections from "./provider-connections";
import { cleanupProviderOAuthFlows } from "./provider-oauth-cleanup";
import { getConfiguredOAuthProvider, listConfiguredOAuthProviders } from "./provider-oauth-providers";
import { exchangeOAuthAuthorizationCode } from "./provider-oauth-tokens";
import * as senderIdentities from "./sender-identities";
import { enqueueBindingRediscovery } from "./sync-runtime";

const FLOW_TTL_MS = 10 * 60_000;

type OAuthFlowRow = {
  id: string;
  mailbox_id: string;
  user_id: string;
  provider_id: MailOAuthProviderId;
  operation: "create" | "reconnect";
  connection_id: string | null;
  connection_input: unknown;
  create_sender: boolean;
  saves_sent_automatically: boolean;
  encrypted_code_verifier: string;
  status: "pending" | "exchanging" | "completed" | "failed";
  result_connection_id: string | null;
  result_code: string | null;
  diagnostics: ProviderTransportDiagnostics | string | null;
};

const sessionUserId = (context: MailRequestContext): string | null => (context.actor.kind === "user" ? context.actor.user.id : null);
const randomUrlToken = (bytes: number): string => randomBytes(bytes).toString("base64url");

export const createPkceMaterial = (): {
  state: string;
  browserNonce: string;
  codeVerifier: string;
  codeChallenge: string;
} => {
  const codeVerifier = randomUrlToken(48);
  return {
    state: randomUrlToken(32),
    browserNonce: randomUrlToken(32),
    codeVerifier,
    codeChallenge: Buffer.from(sha256Text(codeVerifier), "hex").toString("base64url"),
  };
};

export const providerOAuthCallbackUri = async (): Promise<string> => {
  const raw = (await coreSettings.get<string>("app.url")).trim();
  const base = new URL(raw.startsWith("http://") || raw.startsWith("https://") ? raw : `https://${raw}`);
  const localDevelopment = base.hostname === "localhost" || base.hostname === "127.0.0.1" || base.hostname === "::1";
  if (base.protocol !== "https:" && !(base.protocol === "http:" && localDevelopment))
    throw new Error("Mail OAuth requires an HTTPS app.url");
  return new URL("/api/mail/oauth/callback", base).toString();
};

const connectionDetailsForStart = async (
  context: MailRequestContext,
  mailboxId: string,
  input: MailOAuthStartInput,
): Promise<
  Result<{
    details: ProviderConnectionDetails;
    connectionId: string | null;
    createSender: boolean;
    savesSentAutomatically: boolean;
  }>
> => {
  if (input.operation === "create")
    return ok({
      details: input.connection,
      connectionId: null,
      createSender: input.createSender,
      savesSentAutomatically: input.savesSentAutomatically,
    });
  const connection = await providerConnections.getProviderConnection(context, input.connectionId);
  if (!connection.ok) return connection;
  if (connection.data.mailboxId !== mailboxId || connection.data.status === "revoked") return fail(err.notFound("Provider connection"));
  if (connection.data.oauth?.providerId && connection.data.oauth.providerId !== input.providerId) {
    return fail(err.badInput("Reconnect must use the connection's configured OAuth provider"));
  }
  return ok({
    connectionId: connection.data.id,
    createSender: false,
    savesSentAutomatically: false,
    details:
      input.connection ??
      ({
        name: connection.data.name,
        email: connection.data.email,
        username: connection.data.username,
        imap: connection.data.imap,
        smtp: connection.data.smtp,
      } satisfies ProviderConnectionDetails),
  });
};

export const startProviderOAuth = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  input: MailOAuthStartInput;
}): Promise<Result<MailOAuthStartResult & { browserNonce: string; cookieName: string }>> => {
  const userId = sessionUserId(params.context);
  if (!userId) return fail(err.forbidden("Browser OAuth requires an active user session"));
  const parsed = mailOAuthStartInputSchema.safeParse(params.input);
  if (!parsed.success) return fail(err.badInput(parsed.error.issues[0]?.message ?? "Invalid OAuth request"));
  const permission = await requireMailboxPermission(params.context, params.mailboxId, "admin");
  if (!permission.ok) return permission;
  const configured = await getConfiguredOAuthProvider(parsed.data.providerId);
  if (!configured) return fail(err.badInput("OAuth provider is not configured"));
  const connection = await connectionDetailsForStart(params.context, params.mailboxId, parsed.data);
  if (!connection.ok) return connection;

  const material = createPkceMaterial();
  const expiresAt = new Date(Date.now() + FLOW_TTL_MS).toISOString();
  const encryptedVerifier = await encryptSecret({ codeVerifier: material.codeVerifier });
  const callbackUri = await providerOAuthCallbackUri();
  await cleanupProviderOAuthFlows().catch(() => undefined);
  const [flow] = await sql<{ id: string }[]>`
    INSERT INTO mail.provider_oauth_flows (
      state_hash, browser_nonce_hash, mailbox_id, user_id, provider_id, operation,
      connection_id, connection_input, create_sender, saves_sent_automatically, encrypted_code_verifier, expires_at
    )
    VALUES (
      ${sha256Text(material.state)}, ${sha256Text(material.browserNonce)}, ${params.mailboxId}::uuid,
      ${userId}::uuid, ${parsed.data.providerId}, ${parsed.data.operation}, ${connection.data.connectionId}::uuid,
      ${connection.data.details}::jsonb, ${connection.data.createSender}, ${connection.data.savesSentAutomatically},
      ${encryptedVerifier}, ${expiresAt}::timestamptz
    )
    RETURNING id
  `;
  if (!flow) return fail(err.internal("Could not start OAuth onboarding"));

  const authorizationUrl = new URL(configured.declaration.authorizationEndpoint);
  authorizationUrl.searchParams.set("response_type", "code");
  authorizationUrl.searchParams.set("client_id", configured.clientId);
  authorizationUrl.searchParams.set("redirect_uri", callbackUri);
  authorizationUrl.searchParams.set("scope", configured.declaration.scopes.join(" "));
  authorizationUrl.searchParams.set("state", material.state);
  authorizationUrl.searchParams.set("code_challenge", material.codeChallenge);
  authorizationUrl.searchParams.set("code_challenge_method", "S256");
  for (const [key, value] of Object.entries(configured.declaration.authorizationParameters)) authorizationUrl.searchParams.set(key, value);

  await audit.record({
    action: "mail.provider_oauth.start",
    outcome: "allowed",
    actor: auditActorFromRequest(params.context),
    target: { type: "mailbox", id: params.mailboxId },
    requestId: params.context.requestId,
    metadata: { flowId: flow.id, providerId: parsed.data.providerId, operation: parsed.data.operation },
  });
  return ok({
    authorizationUrl: authorizationUrl.toString(),
    expiresAt,
    browserNonce: material.browserNonce,
    cookieName: `mail_oauth_${sha256Text(material.state).slice(0, 20)}`,
  });
};

const markFlowFailed = async (
  flowId: string,
  code: string,
  message: string,
  diagnostics: ProviderTransportDiagnostics | null = null,
): Promise<void> => {
  await sql`
    UPDATE mail.provider_oauth_flows
    SET status = 'failed', result_code = ${code}, result_message = ${message}, diagnostics = ${diagnostics}::jsonb,
        completed_at = now(), encrypted_code_verifier = 'destroyed', updated_at = now()
    WHERE id = ${flowId}::uuid AND status = 'exchanging'
  `;
};

const retainedRefreshToken = async (connectionId: string | null): Promise<string | null> => {
  if (!connectionId) return null;
  const [row] = await sql<{ encrypted_secret: string }[]>`
    SELECT encrypted_secret
    FROM mail.provider_connections
    WHERE id = ${connectionId}::uuid AND status <> 'revoked' AND encrypted_secret IS NOT NULL
  `;
  if (!row) return null;
  const secret = providerSecretSchema.parse(await decryptSecret<ProviderSecret>(row.encrypted_secret));
  return secret.kind === "oauth2" ? (secret.refreshToken ?? null) : null;
};

export type ProviderOAuthCompletion = {
  flowId: string | null;
  mailboxId: string | null;
  outcome: "connected" | "reconnected" | "partial" | "failed";
};

export const completeProviderOAuth = async (params: {
  context: MailRequestContext;
  state: string;
  browserNonce: string;
  code: string | null;
  providerDenied: boolean;
}): Promise<ProviderOAuthCompletion> => {
  const userId = sessionUserId(params.context);
  if (!userId) return { flowId: null, mailboxId: null, outcome: "failed" };
  const stateHash = sha256Text(params.state);
  const nonceHash = sha256Text(params.browserNonce);
  let [flow] = await sql<OAuthFlowRow[]>`
    UPDATE mail.provider_oauth_flows
    SET status = 'exchanging', consumed_at = now(), updated_at = now()
    WHERE state_hash = ${stateHash}
      AND browser_nonce_hash = ${nonceHash}
      AND user_id = ${userId}::uuid
      AND status = 'pending'
      AND consumed_at IS NULL
      AND expires_at > now()
    RETURNING id, mailbox_id, user_id, provider_id, operation, connection_id, connection_input,
              create_sender, saves_sent_automatically, encrypted_code_verifier, status, result_connection_id, result_code, diagnostics
  `;
  if (!flow) {
    [flow] = await sql<OAuthFlowRow[]>`
      SELECT id, mailbox_id, user_id, provider_id, operation, connection_id, connection_input,
             create_sender, saves_sent_automatically, encrypted_code_verifier, status, result_connection_id, result_code, diagnostics
      FROM mail.provider_oauth_flows
      WHERE state_hash = ${stateHash}
        AND browser_nonce_hash = ${nonceHash}
        AND user_id = ${userId}::uuid
        AND (status = 'completed' OR (status = 'exchanging' AND result_connection_id IS NOT NULL))
    `;
  }
  if (!flow) return { flowId: null, mailboxId: null, outcome: "failed" };
  if (flow.status === "completed") {
    const completedOutcome: ProviderOAuthCompletion["outcome"] =
      flow.result_code === "RECONNECTED" ? "reconnected" : flow.result_code === "PARTIAL" ? "partial" : "connected";
    return { flowId: flow.id, mailboxId: flow.mailbox_id, outcome: completedOutcome };
  }
  const failed = async (code: string, message: string, diagnostics: ProviderTransportDiagnostics | null = null) => {
    await markFlowFailed(flow.id, code, message, diagnostics);
    return { flowId: flow.id, mailboxId: flow.mailbox_id, outcome: "failed" as const };
  };
  const completePartial = async (message: string, diagnostics: ProviderTransportDiagnostics | null = null) => {
    await sql`
      UPDATE mail.provider_oauth_flows
      SET status = 'completed', result_code = 'PARTIAL', result_message = ${message},
          diagnostics = COALESCE(${diagnostics}::jsonb, diagnostics), completed_at = now(),
          encrypted_code_verifier = 'destroyed', updated_at = now()
      WHERE id = ${flow.id}::uuid AND status = 'exchanging' AND result_connection_id IS NOT NULL
    `;
    return { flowId: flow.id, mailboxId: flow.mailbox_id, outcome: "partial" as const };
  };
  if (!flow.result_connection_id && (params.providerDenied || !params.code)) {
    return failed("PROVIDER_DENIED", "Authorization was not completed");
  }
  const permission = await requireMailboxPermission(params.context, flow.mailbox_id, "admin");
  if (!permission.ok) {
    return flow.result_connection_id
      ? completePartial("Provider connected, but mailbox administration permission changed before setup completed")
      : failed("PERMISSION_CHANGED", "Mailbox administration permission is no longer available");
  }

  let connectionId = flow.result_connection_id;
  let diagnostics = flow.diagnostics
    ? providerTransportDiagnosticsSchema.parse(typeof flow.diagnostics === "string" ? JSON.parse(flow.diagnostics) : flow.diagnostics)
    : null;
  try {
    if (!connectionId) {
      const verifier = await decryptSecret<{ codeVerifier: string }>(flow.encrypted_code_verifier);
      if (!verifier.codeVerifier || verifier.codeVerifier.length > 256) return failed("FLOW_INVALID", "OAuth flow could not be verified");
      const details = providerConnectionDetailsSchema.parse(flow.connection_input);
      const oldRefreshToken = await retainedRefreshToken(flow.connection_id);
      const tokens = await exchangeOAuthAuthorizationCode({
        providerId: flow.provider_id,
        code: params.code!,
        codeVerifier: verifier.codeVerifier,
        redirectUri: await providerOAuthCallbackUri(),
        retainedRefreshToken: oldRefreshToken,
      });
      if (!tokens.refreshToken) {
        return failed("REFRESH_TOKEN_MISSING", "Provider did not issue durable offline access; reconnect with consent");
      }
      const input = {
        ...details,
        secret: {
          kind: "oauth2" as const,
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          expiresAt: tokens.expiresAt,
        },
      };
      const transport = await verifyImapSmtpTransports(input);
      diagnostics = transport.diagnostics;
      if (!transport.verification) {
        return failed("TRANSPORT_VERIFICATION_FAILED", "Provider authorization did not verify both transports", diagnostics);
      }
      const checkpoint = async (db: typeof sql, connection: { id: string }) => {
        const [stored] = await db<{ id: string }[]>`
          UPDATE mail.provider_oauth_flows
          SET result_connection_id = ${connection.id}::uuid, diagnostics = ${diagnostics}::jsonb,
              encrypted_code_verifier = 'destroyed', updated_at = now()
          WHERE id = ${flow.id}::uuid AND status = 'exchanging' AND result_connection_id IS NULL
          RETURNING id
        `;
        if (!stored) throw new Error("OAuth flow checkpoint changed during connection storage");
      };
      const connectionResult =
        flow.operation === "create"
          ? await providerConnections.createProviderConnection({
              context: params.context,
              mailboxId: flow.mailbox_id,
              input,
              managedOAuth: { providerId: flow.provider_id, expiresAt: tokens.expiresAt },
              onStored: checkpoint,
            })
          : await providerConnections.replaceProviderConnection({
              context: params.context,
              connectionId: flow.connection_id!,
              input,
              managedOAuth: { providerId: flow.provider_id, expiresAt: tokens.expiresAt },
              onStored: checkpoint,
            });
      if (!connectionResult.ok) return failed(connectionResult.error.code, connectionResult.error.message);
      connectionId = connectionResult.data.connection.id;
    }

    let outcome: ProviderOAuthCompletion["outcome"] = flow.operation === "create" ? "connected" : "reconnected";
    const connectionBindings = await bindings.listProviderBindings(params.context, flow.mailbox_id);
    if (flow.operation === "create") {
      let bindingId = connectionBindings.ok
        ? (connectionBindings.data.find((binding) => binding.connectionId === connectionId && binding.state === "active")?.id ?? null)
        : null;
      if (!bindingId) {
        const binding = await bindings.attachProviderBinding({
          context: params.context,
          mailboxId: flow.mailbox_id,
          connectionId,
        });
        if (binding.ok) bindingId = binding.data.id;
        else outcome = "partial";
      }
      if (flow.create_sender && bindingId) {
        const sender = await senderIdentities.setupDefaultSender({
          context: params.context,
          mailboxId: flow.mailbox_id,
          input: { bindingId, savesSentAutomatically: flow.saves_sent_automatically },
        });
        if (!sender.ok) outcome = "partial";
      }
    } else {
      if (!connectionBindings.ok) outcome = "partial";
      else {
        const matching = connectionBindings.data.filter((binding) => binding.connectionId === connectionId && binding.state !== "revoked");
        const queued = await Promise.allSettled(matching.map((binding) => enqueueBindingRediscovery(binding.id, true)));
        if (queued.some((entry) => entry.status === "rejected")) outcome = "partial";
      }
    }

    await sql`
      UPDATE mail.provider_oauth_flows
      SET status = 'completed', result_connection_id = ${connectionId}::uuid,
          result_code = ${outcome.toUpperCase()}, result_message = ${outcome === "partial" ? "Provider connected; setup still requires attention" : "Provider connected"},
          diagnostics = ${diagnostics}::jsonb, completed_at = now(), encrypted_code_verifier = 'destroyed', updated_at = now()
      WHERE id = ${flow.id}::uuid AND status = 'exchanging'
    `;
    await audit.record({
      action: "mail.provider_oauth.complete",
      outcome: "allowed",
      actor: auditActorFromRequest(params.context),
      target: { type: "provider_connection", id: connectionId },
      requestId: params.context.requestId,
      metadata: { flowId: flow.id, providerId: flow.provider_id, operation: flow.operation, result: outcome },
    });
    return { flowId: flow.id, mailboxId: flow.mailbox_id, outcome };
  } catch {
    return connectionId
      ? completePartial("Provider connected, but setup did not finish", diagnostics)
      : failed("OAUTH_EXCHANGE_FAILED", "OAuth authorization could not be completed");
  }
};

export const getProviderOAuthFlowResult = async (context: MailRequestContext, flowId: string): Promise<Result<MailOAuthFlowResult>> => {
  const userId = sessionUserId(context);
  if (!userId) return fail(err.forbidden("Browser OAuth requires an active user session"));
  const [row] = await sql<
    {
      id: string;
      mailbox_id: string;
      status: MailOAuthFlowResult["status"];
      result_code: string | null;
      result_message: string | null;
      result_connection_id: string | null;
      diagnostics: unknown;
    }[]
  >`
    SELECT id, mailbox_id, status, result_code, result_message, result_connection_id, diagnostics
    FROM mail.provider_oauth_flows
    WHERE id = ${flowId}::uuid AND user_id = ${userId}::uuid
  `;
  if (!row) return fail(err.notFound("OAuth flow"));
  const permission = await requireMailboxPermission(context, row.mailbox_id, "admin");
  if (!permission.ok) return permission;
  const diagnostics = row.diagnostics ? providerTransportDiagnosticsSchema.safeParse(row.diagnostics) : null;
  return ok({
    id: row.id,
    mailboxId: row.mailbox_id,
    status: row.status,
    resultCode: row.result_code,
    message: row.result_message,
    connectionId: row.result_connection_id,
    diagnostics: diagnostics?.success ? diagnostics.data : null,
  });
};

export { listConfiguredOAuthProviders };
