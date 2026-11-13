import { AuditClient, AuditDispatcher } from "../audit/outbox.ts";
import { EmbeddingIndex } from "../search/embeddings.ts";
import {
  createEmbeddingProvider,
  type EmbeddingConfig,
} from "../providers/embeddings.ts";
import { AdminQueries } from "../domain/admin-queries.ts";
import { HarnessAgent } from "../agent/agent.ts";
import { createModelProviders, type AgentConfig } from "../agent/providers.ts";
import { SourceEdits } from "../domain/source-edits.ts";
import { Search } from "../search/search.ts";
import { Conversations } from "../domain/conversations.ts";
import { Management } from "../domain/management.ts";
import { SourceAccess } from "../domain/source-access.ts";
import { ProtectedContent } from "../domain/protected-content.ts";
import { LineIdentity } from "../providers/line-identity.ts";
import { AssetOriginalClient } from "../providers/asset-original.ts";
import type { Pool } from "pg";
import { Store, requireRuntimeGeneration } from "../persistence/store.ts";
import { ReplyTokenCipher } from "../reply/token.ts";
import { Registration } from "../domain/registration.ts";
import { Interactions } from "../domain/interactions.ts";
import { AccountClient } from "../providers/account.ts";
import { AssetClient } from "../providers/asset.ts";
import { LineClient } from "../providers/line.ts";
import type { LineEvent } from "../domain/events.ts";
export interface RuntimeConfig {
  runtimeGeneration?: string;
  audit?: { origin: string; token: string };
  agent?: AgentConfig;
  embeddings?: EmbeddingConfig;
  channelId: string;
  botId: string;
  lineProfile: string;
  lineAccessToken: string;
  replyEncryptionKey: string;
  accountOrigin: string;
  accountToken: string;
  assetOrigin: string;
  assetToken: string;
  adminOrigin: string;
  sourceAccessToken: string;
  gatewayToken: string;
  lineLoginChannelId: string;
  liffId?: string;
  queueUrl: string;
  identityClientId: string;
}
export function createRuntime(
  pool: Pool,
  config: RuntimeConfig,
  fetcher: typeof fetch = fetch,
) {
  if (!/^U[0-9a-f]{32}$/.test(config.botId))
    throw new Error("invalid_bot_identity");
  const store = new Store(
    pool,
    new ReplyTokenCipher(config.replyEncryptionKey),
    config.channelId,
  );
  const account = new AccountClient(
    config.accountOrigin,
    config.accountToken,
    config.lineProfile,
    config.channelId,
    fetcher,
  );
  const asset = new AssetClient(config.assetOrigin, config.assetToken, fetcher);
  const line = new LineClient(config.lineAccessToken, fetcher);
  const registration = new Registration(store, {
    subject: (actor, type, id) => account.subject(actor, type, id),
    addReader: (collection, subject, expected, operation, actor) =>
      asset.addReader(collection, subject, expected, operation, actor),
    groupName: (group) => line.groupName(group),
    authority: (id) => account.authority(id),
    member: (group, id) => line.member(group, id),
    collection: (id) => asset.collection(id),
    send: (token, text) => line.reply(token, text),
  });
  const management = new Management(store, registration, {
    authority: (id) => account.subjectAuthority(id),
    revokeReader: (collection, acl, expected, operation, actor) =>
      asset.revokeReader(collection, acl, expected, operation, actor),
    subjects: (actor, type, query, page) =>
      account.subjects(actor, type, query, page),
    collections: (cursor) => asset.collections(cursor),
    createCollection: (id, name, actor) =>
      asset.createCollection(id, name, actor),
  });
  const search = new Search(store, (group, actor) => line.member(group, actor));
  const sourceEdits = new SourceEdits(store, search, (actor) =>
    account.authority(actor),
  );
  const embeddingProvider = config.embeddings
    ? createEmbeddingProvider(config.embeddings, fetcher)
    : undefined;
  const models = config.agent
    ? createModelProviders(config.agent, fetcher)
    : undefined;
  const embeddings = embeddingProvider
    ? new EmbeddingIndex(store, embeddingProvider)
    : undefined;
  const agent = models
    ? new HarnessAgent(store, search, sourceEdits, models, embeddings)
    : undefined;
  const conversations = new Conversations(store, search, agent);
  const adminQueries = agent
    ? new AdminQueries(store, management, agent)
    : undefined;
  const interactions = new Interactions(store, registration, {
    management,
    adminQueries,
    conversations,
    sourceEdits,
    liffId: config.liffId,
    binding: async (id) => account.binding(id, await line.linkToken(id)),
    finalize: (id, nonce, result, eventId) =>
      account.finalize(id, nonce, result, eventId),
    send: (token, text, actions) => line.reply(token, text, actions),
    adminOrigin: config.adminOrigin,
  });
  const sourceAccess = new SourceAccess(store);
  const identity = new LineIdentity(config.lineLoginChannelId, fetcher);
  const assetContent = new AssetOriginalClient(
    config.assetOrigin,
    config.assetToken,
    [config.assetOrigin],
    fetcher,
  );
  const content = new ProtectedContent(store, {
    identity: (token) => identity.verify(token),
    member: (group, user) => line.member(group, user),
    open: (id, method, headers) => assetContent.content(id, method, headers),
  });
  const auditClient = config.audit
    ? new AuditClient(config.audit.origin, config.audit.token, fetcher)
    : undefined;
  const audit = auditClient
    ? new AuditDispatcher(store, (event) => auditClient.append(event))
    : undefined;
  return {
    close: async () => {
      await Promise.all([models?.close(), embeddingProvider?.close()]);
    },
    audit,
    management: {
      service: management,
      token: config.gatewayToken,
    },
    content,
    adminQueries,
    conversations,
    searchAccess: {
      service: conversations,
      edits: sourceEdits,
      liffId: config.liffId,
      identity: (token: string) => identity.verify(token),
    },
    sourceAccess: {
      token: config.sourceAccessToken,
      check: (input: unknown) => sourceAccess.check(input),
    },
    initialize: async () => {
      await requireRuntimeGeneration(pool, config.runtimeGeneration ?? "1");
      await asset.checkPolicy();
      await embeddings?.prepare();
      await pool.query("SELECT generation FROM runtime_state");
    },
    store,
    registration,
    interactions,
    intake: {
      botId: config.botId,
      ingest: (event: LineEvent) =>
        store.ingest(event, (client, accepted, group) =>
          interactions.record(client, accepted, group),
        ),
    },
  };
}
