import type {
  CodedError,
  WebAPIPlatformError,
  WebClient,
} from "@slack/web-api";
import { ErrorCode } from "@slack/web-api";
import type { Channel } from "@slack/web-api/dist/response/ChannelsInfoResponse";
import type {
  ConversationsHistoryResponse,
  MessageElement,
} from "@slack/web-api/dist/response/ConversationsHistoryResponse";
import { Context } from "@temporalio/activity";
import PQueue from "p-queue";
import { Op, Sequelize } from "sequelize";

import {
  getBotUserIdMemoized,
  getUserCacheKey,
} from "@connectors/connectors/slack/lib/bot_user_helpers";
import {
  getChannelById,
  getChannels,
  joinChannel,
  updateSlackChannelInConnectorsDb,
  updateSlackChannelInCoreDb,
} from "@connectors/connectors/slack/lib/channels";
import { formatMessagesForUpsert } from "@connectors/connectors/slack/lib/messages";
import {
  getSlackClient,
  reportSlackUsage,
  withSlackErrorHandling,
} from "@connectors/connectors/slack/lib/slack_client";
import { getRepliesFromThread } from "@connectors/connectors/slack/lib/thread";
import {
  getSlackChannelSourceUrl,
  getWeekEnd,
  getWeekStart,
  MAX_SYNC_NON_THREAD_MESSAGES,
  slackChannelInternalIdFromSlackChannelId,
  slackNonThreadedMessagesInternalIdFromSlackNonThreadedMessagesIdentifier,
  slackThreadInternalIdFromSlackThreadIdentifier,
} from "@connectors/connectors/slack/lib/utils";
import { dataSourceConfigFromConnector } from "@connectors/lib/api/data_source_config";
import { cacheSet } from "@connectors/lib/cache";
import {
  deleteDataSourceDocument,
  deleteDataSourceFolder,
  upsertDataSourceDocument,
  upsertDataSourceFolder,
} from "@connectors/lib/data_sources";
import { ProviderWorkflowError } from "@connectors/lib/error";
import { SlackChannel, SlackMessages } from "@connectors/lib/models/slack";
import {
  reportInitialSyncProgress,
  syncSucceeded,
} from "@connectors/lib/sync_status";
import { heartbeat } from "@connectors/lib/temporal";
import { isSlowLaneQueue } from "@connectors/lib/temporal_queue_routing";
import mainLogger from "@connectors/logger/logger";
import { ConnectorResource } from "@connectors/resources/connector_resource";
import { SlackConfigurationResource } from "@connectors/resources/slack_configuration_resource";
import type { ModelId } from "@connectors/types";
import type { DataSourceConfig } from "@connectors/types";
import { INTERNAL_MIME_TYPES } from "@connectors/types";

const logger = mainLogger.child({ provider: "slack" });

// This controls the maximum number of concurrent calls to syncThread and syncNonThreaded.
const MAX_CONCURRENCY_LEVEL = 2;
// Adaptive chunking constants for syncNonThreaded optimization
const MAX_API_CALLS_PER_CHUNK = 20; // Stop processing if we hit this many API calls in a chunk.

const CONVERSATION_HISTORY_LIMIT = 100;

interface SyncChannelRes {
  nextCursor?: string;
  weeksSynced: Record<number, boolean>;
}

export async function syncChannel(
  channelId: string,
  connectorId: ModelId,
  fromTs: number | null,
  weeksSynced: Record<number, boolean>,
  messagesCursor?: string
): Promise<SyncChannelRes | undefined> {
  const connector = await ConnectorResource.fetchById(connectorId);
  if (!connector) {
    throw new Error(`Connector ${connectorId} not found`);
  }

  const slackClient = await getSlackClient(connectorId, {
    // Let the Slack client handle rate limited calls in the slow lane.
    rejectRateLimitedCalls: !isSlowLaneQueue(Context.current().info.taskQueue),
  });

  const remoteChannel = await withSlackErrorHandling(() =>
    getChannelById(slackClient, connectorId, channelId)
  );
  if (!remoteChannel.name) {
    throw new Error(`Could not find channel name for channel ${channelId}`);
  }
  const dataSourceConfig = dataSourceConfigFromConnector(connector);

  const channel = await updateSlackChannelInConnectorsDb({
    slackChannelId: channelId,
    slackChannelName: remoteChannel.name,
    connectorId: connectorId,
  });

  const slackConfiguration =
    await SlackConfigurationResource.fetchByConnectorId(connectorId);

  if (!slackConfiguration) {
    throw new Error(
      `Could not find slack configuration for connector ${connectorId}`
    );
  }

  // Check if channel has a skipReason
  const slackChannel = await SlackChannel.findOne({
    where: {
      connectorId,
      slackChannelId: channelId,
    },
  });

  if (slackChannel?.skipReason) {
    logger.info(
      {
        connectorId,
        channelId,
        channelName: remoteChannel.name,
        skipReason: slackChannel.skipReason,
      },
      `Skipping channel sync: ${slackChannel.skipReason}`
    );
    return;
  }

  if (!["read", "read_write"].includes(channel.permission)) {
    logger.info(
      {
        connectorId,
        channelId,
        channelName: remoteChannel.name,
      },
      "Channel is not indexed, skipping"
    );
    return;
  }

  // If the cursor is not set this is the first call to syncChannel so we upsert the associated
  // folder.
  if (!messagesCursor) {
    await upsertDataSourceFolder({
      dataSourceConfig,
      folderId: slackChannelInternalIdFromSlackChannelId(channelId),
      title: `#${channel.name}`,
      parentId: null,
      parents: [slackChannelInternalIdFromSlackChannelId(channelId)],
      mimeType: INTERNAL_MIME_TYPES.SLACK.CHANNEL,
      sourceUrl: getSlackChannelSourceUrl(channelId, slackConfiguration),
      providerVisibility: channel.private ? "private" : "public",
    });
  }

  const threadsToSync: string[] = [];
  let unthreadedTimeframesToSync: number[] = [];
  const messages = await getMessagesForChannel(
    connectorId,
    channelId,
    50,
    messagesCursor
  );
  if (!messages.messages) {
    // This should never happen because we throw an exception in the activity if we get an error
    // from the Slack API, but we need to make typescript happy.
    return {
      nextCursor: messages.response_metadata?.next_cursor,
      weeksSynced: weeksSynced,
    };
  }

  // `allSkip` and `skip` logic assumes that the messages are returned in recency order (newest
  // first).
  let allSkip = true;
  for (const message of messages.messages) {
    if (
      !message.user &&
      !(
        message.bot_profile?.name &&
        (await slackConfiguration.isBotWhitelistedToIndexMessages(
          message.bot_profile.name
        ))
      )
    ) {
      // We do not support messages not posted by users for now, unless it's a whitelisted bot
      continue;
    }
    let skip = false;
    if (message.thread_ts) {
      const threadTs = parseInt(message.thread_ts, 10) * 1000;
      if (fromTs && threadTs < fromTs) {
        skip = true;
        logger.info(
          {
            workspaceId: dataSourceConfig.workspaceId,
            channelId,
            channelName: remoteChannel.name,
            threadTs,
            fromTs,
          },
          "FromTs Skipping thread"
        );
      }
      if (!skip && threadsToSync.indexOf(message.thread_ts) === -1) {
        // We can end up getting two messages from the same thread if a message from a thread
        // has also been "posted to channel".
        threadsToSync.push(message.thread_ts);
      }
    } else {
      const messageTs = parseInt(message.ts as string, 10) * 1000;
      const weekStartTsMs = getWeekStart(new Date(messageTs)).getTime();
      const weekEndTsMs = getWeekEnd(new Date(messageTs)).getTime();
      if (fromTs && weekEndTsMs < fromTs) {
        skip = true;
        logger.info(
          {
            workspaceId: dataSourceConfig.workspaceId,
            channelId,
            channelName: remoteChannel.name,
            messageTs,
            fromTs,
            weekEndTsMs,
            weekStartTsMs,
          },
          "FromTs Skipping non-thread"
        );
      }
      if (!skip && unthreadedTimeframesToSync.indexOf(weekStartTsMs) === -1) {
        unthreadedTimeframesToSync.push(weekStartTsMs);
      }
    }
    if (!skip) {
      allSkip = false;
    }
  }

  unthreadedTimeframesToSync = unthreadedTimeframesToSync.filter(
    (t) => !(t in weeksSynced)
  );

  logger.info(
    {
      connectorId,
      channelId,
      threadsToSyncCount: threadsToSync.length,
      unthreadedTimeframesToSyncCount: unthreadedTimeframesToSync.length,
    },
    "syncChannel.splitMessages"
  );

  await syncThreads(
    dataSourceConfig,
    channelId,
    remoteChannel.name,
    threadsToSync,
    connectorId
  );

  await syncMultipleNonThreaded(
    dataSourceConfig,
    channelId,
    remoteChannel.name,
    Array.from(unthreadedTimeframesToSync.values()),
    connectorId
  );
  unthreadedTimeframesToSync.forEach((t) => (weeksSynced[t] = true));

  return {
    nextCursor: allSkip ? undefined : messages.response_metadata?.next_cursor,
    weeksSynced: weeksSynced,
  };
}

export async function syncChannelMetadata(
  connectorId: ModelId,
  channelId: string,
  timestampsMs: number
) {
  await updateSlackChannelInCoreDb(connectorId, channelId, timestampsMs);
}

export async function getMessagesForChannel(
  connectorId: ModelId,
  channelId: string,
  limit = 100,
  nextCursor?: string
): Promise<ConversationsHistoryResponse> {
  const slackClient = await getSlackClient(connectorId, {
    // Let the Slack client handle rate limited calls in the slow lane.
    rejectRateLimitedCalls: !isSlowLaneQueue(Context.current().info.taskQueue),
  });

  reportSlackUsage({
    connectorId,
    method: "conversations.history",
    channelId,
    limit,
  });
  const c: ConversationsHistoryResponse = await withSlackErrorHandling(() =>
    slackClient.conversations.history({
      channel: channelId,
      limit: limit,
      cursor: nextCursor,
    })
  );
  // Despite the typing, in practice `conversations.history` can be undefined at times.
  if (!c) {
    throw new ProviderWorkflowError(
      "slack",
      "Received unexpected undefined replies from Slack API in getMessagesForChannel (generally transient)",
      "transient_upstream_activity_error"
    );
  }
  if (c.error) {
    throw new Error(
      `Failed getting messages for channel ${channelId}: ${c.error}`
    );
  }

  logger.info(
    {
      messagesCount: c.messages?.length,
      channelId,
      connectorId,
    },
    "getMessagesForChannel"
  );
  return c;
}

interface SyncNonThreadedChunkResult {
  completed: boolean;
  nextCursor?: string;
  messagesProcessed: number;
}

export async function syncNonThreadedChunk({
  channelId,
  channelName,
  connectorId,
  cursor,
  endTsMs,
  // Name is confusing, but kept to avoid breaking changes in Temporal activities.
  ignoreMessageLimit = false,
  isBatchSync = false,
  maxTotalMessages = MAX_SYNC_NON_THREAD_MESSAGES,
  startTsMs,
  weekEndTsMs,
  weekStartTsMs,
}: {
  channelId: string;
  channelName: string;
  connectorId: ModelId;
  cursor?: string;
  endTsMs: number;
  ignoreMessageLimit?: boolean;
  isBatchSync: boolean;
  maxTotalMessages?: number;
  startTsMs: number;
  weekEndTsMs: number;
  weekStartTsMs: number;
}): Promise<SyncNonThreadedChunkResult> {
  const connector = await ConnectorResource.fetchById(connectorId);
  if (!connector) {
    throw new Error(`Connector ${connectorId} not found`);
  }

  const slackConfiguration =
    await SlackConfigurationResource.fetchByConnectorId(connectorId);
  if (!slackConfiguration) {
    throw new Error(
      `Could not find slack configuration for connector ${connector}`
    );
  }

  const dataSourceConfig = dataSourceConfigFromConnector(connector);
  const slackClient = await getSlackClient(connectorId, {
    // Let the Slack client handle rate limited calls in the slow lane.
    rejectRateLimitedCalls: !isSlowLaneQueue(Context.current().info.taskQueue),
  });
  const messages: MessageElement[] = [];

  const startTsSec = Math.round(startTsMs / 1000);
  const endTsSec = Math.round(endTsMs / 1000);

  let hasMore: boolean | undefined = undefined;
  let nextCursor: string | undefined = cursor;
  let apiCallCount = 0;

  do {
    apiCallCount++;
    let c: ConversationsHistoryResponse | undefined = undefined;
    try {
      reportSlackUsage({
        connectorId,
        method: "conversations.history",
        channelId,
        limit: CONVERSATION_HISTORY_LIMIT,
        useCase: isBatchSync ? "batch_sync" : "incremental_sync",
      });
      c = await withSlackErrorHandling(() =>
        slackClient.conversations.history({
          channel: channelId,
          limit: CONVERSATION_HISTORY_LIMIT,
          oldest: `${startTsSec}`,
          latest: `${endTsSec}`,
          cursor: nextCursor,
        })
      );
    } catch (e) {
      const maybeSlackPlatformError = e as WebAPIPlatformError;
      if (
        maybeSlackPlatformError.code === "slack_webapi_platform_error" &&
        maybeSlackPlatformError.data?.error === "not_in_channel"
      ) {
        // If the bot is no longer in the channel, we don't upsert anything.
        return { completed: true, messagesProcessed: 0 };
      }
      throw e;
    }

    if (c?.error) {
      throw new Error(
        `Failed getting messages for channel ${channelId}: ${c.error}`
      );
    }

    if (c?.messages === undefined) {
      logger.error(
        {
          channelId,
          channelName,
          connectorId,
          cursor,
          error: c?.error,
          oldest: startTsSec,
        },
        "Failed getting messages for channel"
      );
      throw new Error(
        `Failed getting messages for channel ${channelId}: messages is undefined`
      );
    }

    await heartbeat();

    for (const message of c.messages) {
      if (
        !message.user &&
        !(
          message.bot_profile?.name &&
          (await slackConfiguration.isBotWhitelistedToIndexMessages(
            message.bot_profile.name
          ))
        )
      ) {
        // We do not support messages not posted by users for now, unless it's a whitelisted bot.
        continue;
      }
      if (!message.thread_ts && message.ts) {
        messages.push(message);
      }
    }
    hasMore = c.has_more;
    nextCursor = c.response_metadata?.next_cursor;

    // Stop if we've made enough API calls for this chunk (unless ignoring limit).
    if (!ignoreMessageLimit && apiCallCount >= MAX_API_CALLS_PER_CHUNK) {
      logger.info(
        {
          apiCallCount,
          messagesCount: messages.length,
          connectorId,
          channelName,
          channelId,
          startTsMs,
          endTsMs,
          latestTsSec: c.messages?.at(-1)?.ts,
        },
        "Chunk reached max API calls, splitting work"
      );

      await processAndUpsertNonThreadedMessages({
        channelId,
        channelName,
        connectorId,
        dataSourceConfig,
        isBatchSync,
        messages,
        slackClient,
        weekEndTsMs,
        weekStartTsMs,
      });

      return {
        completed: false,
        nextCursor,
        messagesProcessed: messages.length,
      };
    }
  } while (hasMore);

  // Apply total message limit.
  if (messages.length > maxTotalMessages) {
    logger.warn(
      {
        messagesCount: messages.length,
        maxTotalMessages,
        connectorId,
        channelName,
        channelId,
        startTsMs,
        endTsMs,
      },
      "Giving up on syncNonThreadedChunk: too many messages"
    );
    // Process only up to the limit.
    messages.splice(maxTotalMessages);
  }

  if (messages.length > 0) {
    await processAndUpsertNonThreadedMessages({
      channelId,
      channelName,
      connectorId,
      dataSourceConfig,
      isBatchSync,
      messages,
      slackClient,
      weekEndTsMs,
      weekStartTsMs,
    });
  }

  return {
    completed: true,
    messagesProcessed: messages.length,
  };
}

async function processAndUpsertNonThreadedMessages({
  channelId,
  channelName,
  connectorId,
  dataSourceConfig,
  isBatchSync,
  messages,
  slackClient,
  weekEndTsMs,
  weekStartTsMs,
}: {
  channelId: string;
  channelName: string;
  connectorId: ModelId;
  dataSourceConfig: DataSourceConfig;
  isBatchSync: boolean;
  messages: MessageElement[];
  slackClient: WebClient;
  weekEndTsMs: number;
  weekStartTsMs: number;
}) {
  if (messages.length === 0) {
    return;
  }

  messages.reverse();

  const content = await withSlackErrorHandling(() =>
    formatMessagesForUpsert({
      dataSourceConfig,
      channelName,
      messages,
      isThread: false,
      connectorId,
      slackClient,
    })
  );

  const startDate = new Date(weekStartTsMs);
  const endDate = new Date(weekEndTsMs);

  // IMPORTANT: Document ID generation relies on weekly start/end dates, not chunk boundaries.
  // This ensures all chunks processing the same week contribute to the same document.
  const documentId =
    slackNonThreadedMessagesInternalIdFromSlackNonThreadedMessagesIdentifier({
      channelId,
      startDate,
      endDate,
    });
  const firstMessage = messages[0];
  let sourceUrl: string | undefined = undefined;

  if (firstMessage && firstMessage.ts) {
    const { ts } = firstMessage;

    reportSlackUsage({
      connectorId,
      method: "chat.getPermalink",
      channelId,
    });
    const linkRes = await withSlackErrorHandling(() =>
      slackClient.chat.getPermalink({
        channel: channelId,
        message_ts: ts,
      })
    );
    if (linkRes.ok && linkRes.permalink) {
      sourceUrl = linkRes.permalink;
    } else {
      logger.error(
        {
          connectorId,
          channelId,
          channelName,
          messageTs: firstMessage.ts,
          linkRes,
        },
        "No documentUrl for Slack non threaded: Failed to get permalink"
      );
    }
  }
  const lastMessage = messages.at(-1);
  const updatedAt = lastMessage?.ts
    ? parseInt(lastMessage.ts, 10) * 1000
    : undefined;

  const tags = getTagsForPage(documentId, channelId, channelName);

  // Only create the document if it doesn't already exist based on the documentId
  const existingMessages = await SlackMessages.findAll({
    where: {
      connectorId: connectorId,
      channelId: channelId,
      documentId: documentId,
    },
    order: [["id", "ASC"]],
    limit: 1,
  });

  if (existingMessages.length === 0) {
    await SlackMessages.create({
      connectorId: connectorId,
      channelId: channelId,
      messageTs: undefined,
      documentId: documentId,
    });
  }

  await upsertDataSourceDocument({
    dataSourceConfig,
    documentId,
    documentContent: content,
    documentUrl: sourceUrl,
    timestampMs: updatedAt,
    tags,
    parentId: slackChannelInternalIdFromSlackChannelId(channelId),
    parents: [documentId, slackChannelInternalIdFromSlackChannelId(channelId)],
    upsertContext: {
      sync_type: isBatchSync ? "batch" : "incremental",
    },
    title:
      tags
        .find((t) => t.startsWith("title:"))
        ?.split(":")
        .slice(1)
        .join(":") ?? "",
    mimeType: INTERNAL_MIME_TYPES.SLACK.MESSAGES,
    async: true,
  });
}

export async function syncMultipleNonThreaded(
  dataSourceConfig: DataSourceConfig,
  channelId: string,
  channelName: string,
  timestampsMs: number[],
  connectorId: ModelId,
  maxTotalMessages = MAX_SYNC_NON_THREAD_MESSAGES
) {
  const queue = new PQueue({ concurrency: MAX_CONCURRENCY_LEVEL });

  const promises = [];

  for (const startTsMs of timestampsMs) {
    const weekEndTsMs = getWeekEnd(new Date(startTsMs)).getTime();

    const p = queue.add(() =>
      syncNonThreadedChunk({
        channelId,
        channelName,
        startTsMs,
        endTsMs: weekEndTsMs,
        connectorId,
        isBatchSync: true,
        // Ignore API call limit to process entire week as single chunk.
        ignoreMessageLimit: true,
        maxTotalMessages,
        weekStartTsMs: startTsMs,
        weekEndTsMs: weekEndTsMs,
      })
    );
    promises.push(p);
  }

  return Promise.all(promises);
}

export async function syncThreads(
  dataSourceConfig: DataSourceConfig,
  channelId: string,
  channelName: string,
  threadsTs: string[],
  connectorId: ModelId
) {
  const queue = new PQueue({ concurrency: MAX_CONCURRENCY_LEVEL });

  const promises = [];
  for (const threadTs of threadsTs) {
    const p = queue.add(async () => {
      // we first check if the bot still has read permissions on the channel
      // there could be a race condition if we are in the middle of syncing a channel but
      // the user revokes the bot's permissions
      const channel = await SlackChannel.findOne({
        where: {
          connectorId: connectorId,
          slackChannelId: channelId,
        },
      });

      if (!channel) {
        throw new Error(
          `Could not find channel ${channelId} in connectors db for connector ${connectorId}`
        );
      }

      if (channel.skipReason) {
        logger.info(
          {
            connectorId,
            channelId,
            channelName,
            skipReason: channel.skipReason,
          },
          `Skipping thread sync: ${channel.skipReason}`
        );
        return;
      }

      if (!["read", "read_write"].includes(channel.permission)) {
        logger.info(
          {
            connectorId,
            channelId,
            channelName,
          },
          "Channel is not indexed, skipping"
        );
        return;
      }

      await heartbeat();

      return syncThread(
        channelId,
        channelName,
        threadTs,
        connectorId,
        true // isBatchSync
      );
    });
    promises.push(p);
  }
  return Promise.all(promises);
}

export async function syncThread(
  channelId: string,
  channelName: string,
  threadTs: string,
  connectorId: ModelId,
  isBatchSync = false
) {
  const connector = await ConnectorResource.fetchById(connectorId);
  if (!connector) {
    throw new Error(`Connector ${connectorId} not found`);
  }
  const dataSourceConfig = dataSourceConfigFromConnector(connector);
  const slackClient = await getSlackClient(connectorId, {
    // Let the Slack client handle rate limited calls in the slow lane.
    rejectRateLimitedCalls: !isSlowLaneQueue(Context.current().info.taskQueue),
  });

  let allMessages: MessageElement[] = [];

  logger.info(
    {
      messagesCount: allMessages.length,
      channelName,
      channelId,
      threadTs,
    },
    "syncThread.getRepliesFromThread.send"
  );

  const now = new Date();

  try {
    allMessages = await withSlackErrorHandling(() =>
      getRepliesFromThread({
        connectorId,
        slackClient,
        channelId,
        threadTs,
        useCase: isBatchSync ? "batch_sync" : "incremental_sync",
      })
    );
    allMessages = allMessages.filter((m) => !!m.user);
  } catch (e) {
    const slackError = e as CodedError;
    if (slackError.code === ErrorCode.PlatformError) {
      const platformError = slackError as WebAPIPlatformError;

      if (platformError.data.error === "thread_not_found") {
        // If the thread is not found we just return and don't upsert anything.
        return;
      }

      if (
        platformError.code === "slack_webapi_platform_error" &&
        platformError.data?.error === "not_in_channel"
      ) {
        // If the bot is no longer in the channel, we don't upsert anything.
        return;
      }
    }
    throw e;
  }

  logger.info(
    {
      messagesCount: allMessages.length,
      channelName,
      channelId,
      threadTs,
      delayMs: new Date().getTime() - now.getTime(),
    },
    "syncThread.getRepliesFromThread.done"
  );

  const documentId = slackThreadInternalIdFromSlackThreadIdentifier({
    channelId,
    threadTs,
  });

  const botUserId = await withSlackErrorHandling(() =>
    getBotUserIdMemoized(slackClient, connectorId)
  );
  allMessages = allMessages.filter((m) => m.user !== botUserId);

  if (allMessages.length === 0) {
    // No threaded messages, so we're done.
    return;
  }

  const content = await withSlackErrorHandling(() =>
    formatMessagesForUpsert({
      dataSourceConfig,
      channelName,
      messages: allMessages,
      isThread: true,
      connectorId,
      slackClient,
    })
  );

  const firstMessage = allMessages[0];
  let sourceUrl: string | undefined = undefined;

  if (firstMessage && firstMessage.ts) {
    const { ts } = firstMessage;

    reportSlackUsage({
      connectorId,
      method: "chat.getPermalink",
      channelId,
    });
    const linkRes = await withSlackErrorHandling(() =>
      slackClient.chat.getPermalink({
        channel: channelId,
        message_ts: ts,
      })
    );
    if (linkRes.ok && linkRes.permalink) {
      sourceUrl = linkRes.permalink;
    } else {
      logger.error(
        {
          connectorId,
          channelId,
          channelName,
          threadTs,
          messageTs: firstMessage.ts,
          linkRes,
        },
        "No documentUrl for Slack thread: Failed to get permalink"
      );
    }
  }
  const lastMessage = allMessages.at(-1);
  const updatedAt = lastMessage?.ts
    ? parseInt(lastMessage.ts, 10) * 1000
    : undefined;

  const tags = getTagsForPage(documentId, channelId, channelName, threadTs);

  const firstMessageObject = await SlackMessages.findOne({
    where: {
      connectorId: connectorId,
      channelId: channelId,
      messageTs: threadTs,
    },
  });
  if (firstMessageObject && firstMessageObject.skipReason) {
    logger.info(
      {
        connectorId,
        channelId,
        threadTs,
        skipReason: firstMessageObject.skipReason,
      },
      `Skipping thread : ${firstMessageObject.skipReason}`
    );
    return;
  }

  // Only create the document if it doesn't already exist based on the documentId
  const existingMessages = await SlackMessages.findAll({
    where: {
      connectorId: connectorId,
      channelId: channelId,
      documentId: documentId,
    },
    order: [["id", "ASC"]],
    limit: 1,
  });
  if (existingMessages[0]) {
    await existingMessages[0].update({
      messageTs: threadTs,
    });
  } else {
    await SlackMessages.create({
      connectorId: connectorId,
      channelId: channelId,
      messageTs: threadTs,
      documentId: documentId,
    });
  }

  await upsertDataSourceDocument({
    dataSourceConfig,
    documentId,
    documentContent: content,
    documentUrl: sourceUrl,
    timestampMs: updatedAt,
    tags,
    parentId: slackChannelInternalIdFromSlackChannelId(channelId),
    parents: [documentId, slackChannelInternalIdFromSlackChannelId(channelId)],
    upsertContext: {
      sync_type: isBatchSync ? "batch" : "incremental",
    },
    title:
      tags
        .find((t) => t.startsWith("title:"))
        ?.split(":")
        .slice(1)
        .join(":") ?? "",
    mimeType: INTERNAL_MIME_TYPES.SLACK.THREAD,
    async: true,
  });
}

export async function fetchUsers(connectorId: ModelId) {
  let cursor: string | undefined;
  const slackClient = await getSlackClient(connectorId, {
    // Let the Slack client handle rate limited calls in the slow lane.
    rejectRateLimitedCalls: !isSlowLaneQueue(Context.current().info.taskQueue),
  });
  do {
    reportSlackUsage({
      connectorId,
      method: "users.list",
      limit: 100,
    });
    const res = await withSlackErrorHandling(() =>
      slackClient.users.list({
        cursor: cursor,
        limit: 100,
      })
    );
    if (res.error) {
      throw new Error(`Failed to fetch users: ${res.error}`);
    }
    if (!res.members) {
      throw new Error(`Failed to fetch users: members is undefined`);
    }
    for (const member of res.members) {
      if (member.id && member.name) {
        await cacheSet(getUserCacheKey(member.id, connectorId), member.name);
      }
    }
    cursor = res.response_metadata?.next_cursor;
  } while (cursor);
}

export async function saveSuccessSyncActivity(connectorId: ModelId) {
  logger.info(
    {
      connectorId,
    },
    "Saving success sync activity for connector"
  );
  await syncSucceeded(connectorId);
}

export async function reportInitialSyncProgressActivity(
  connectorId: ModelId,
  progress: string
) {
  await reportInitialSyncProgress(connectorId, progress);
}

export async function getChannel(
  connectorId: ModelId,
  channelId: string
): Promise<Channel> {
  const slackClient = await getSlackClient(connectorId, {
    // Let the Slack client handle rate limited calls in the slow lane.
    rejectRateLimitedCalls: !isSlowLaneQueue(Context.current().info.taskQueue),
  });

  return getChannelById(slackClient, connectorId, channelId);
}

function getTagsForPage(
  documentId: string,
  channelId: string,
  channelName: string,
  threadTs?: string
): string[] {
  const tags: string[] = [
    `channelId:${channelId}`,
    `channelName:${channelName}`,
  ];
  if (threadTs) {
    tags.push(`threadId:${threadTs}`);
    const threadDate = new Date(parseInt(threadTs) * 1000);
    const dateForTitle = formatDateForThreadTitle(threadDate);
    tags.push(`title:${channelName}-thread-${dateForTitle}`);
  } else {
    // replace `slack-${channelId}` by `${channelName}` in documentId (to have a human readable
    // title with non-threaded time boundaries present in the documentId, but the channelName
    // instead of the channelId).
    const parts = documentId.split("-").slice(1);
    parts[0] = channelName;
    const title = parts.join("-");
    tags.push(`title:${title}`);
  }
  return tags;
}

export function formatDateForThreadTitle(date: Date) {
  const year = date.getFullYear();
  const month = (date.getMonth() + 1).toString().padStart(2, "0");
  const day = date.getDate().toString().padStart(2, "0");
  const hours = date.getHours().toString().padStart(2, "0");
  const minutes = date.getMinutes().toString().padStart(2, "0");

  return `${year}-${month}-${day}_${hours}h${minutes}`;
}

export async function getChannelsToGarbageCollect(
  connectorId: ModelId
): Promise<{
  // either no longer visible to the integration, or bot no longer has read permission on
  channelsToDeleteFromDataSource: string[];
  // no longer visible to the integration (subset of channelsToDeleteFromDatasource)
  channelsToDeleteFromConnectorsDb: string[];
}> {
  const channelsInConnectorsDb = await SlackChannel.findAll({
    where: {
      connectorId: connectorId,
    },
  });
  const channelIdsWithoutReadPermission = new Set(
    channelsInConnectorsDb
      .filter(
        (c) =>
          !["read", "read_write"].includes(c.permission) ||
          c.skipReason !== null
      )
      .map((c) => c.slackChannelId)
  );

  const slackClient = await getSlackClient(connectorId, {
    // Let the Slack client handle rate limited calls in the slow lane.
    rejectRateLimitedCalls: !isSlowLaneQueue(Context.current().info.taskQueue),
  });

  const remoteChannels = new Set(
    (
      await withSlackErrorHandling(() =>
        getChannels(slackClient, connectorId, true)
      )
    )
      .filter((c) => c.id)
      .map((c) => c.id as string)
  );

  const localChannels = await SlackMessages.findAll({
    attributes: [
      [Sequelize.fn("DISTINCT", Sequelize.col("channelId")), "channelId"],
    ],
    where: {
      connectorId: connectorId,
    },
  });

  const localChannelsIds = localChannels.map((c) => c.channelId);

  const channelsToDeleteFromDataSource = localChannelsIds.filter((lc) => {
    // we delete from the datasource content from channels that:
    // - are no longer visible to our integration
    // - the bot does not have read permission on
    return !remoteChannels.has(lc) || channelIdsWithoutReadPermission.has(lc);
  });
  const channelsToDeleteFromConnectorsDb = channelsInConnectorsDb
    .filter((c) => !remoteChannels.has(c.slackChannelId))
    .map((c) => c.slackChannelId);

  return {
    channelsToDeleteFromDataSource,
    channelsToDeleteFromConnectorsDb,
  };
}

export async function deleteChannel(channelId: string, connectorId: ModelId) {
  const maxMessages = 1000;
  let nbDeleted = 0;
  const loggerArgs = { channelId, connectorId };
  const connector = await ConnectorResource.fetchById(connectorId);
  if (!connector) {
    throw new Error(`Could not find connector ${connectorId}`);
  }
  const dataSourceConfig = dataSourceConfigFromConnector(connector);
  let slackMessages: SlackMessages[] = [];
  do {
    slackMessages = await SlackMessages.findAll({
      where: {
        channelId: channelId,
        connectorId: connectorId,
      },
      limit: maxMessages,
    });
    for (const slackMessage of slackMessages) {
      // We delete from the remote datasource first because we would rather double delete remotely
      // than miss one.
      await deleteDataSourceDocument(
        dataSourceConfig,
        slackMessage.documentId,
        loggerArgs
      );
      nbDeleted++;

      if (nbDeleted % 50 === 0) {
        await heartbeat();
      }
    }

    // Batch delete after we deleted from the remote datasource
    await SlackMessages.destroy({
      where: {
        channelId: channelId,
        connectorId: connectorId,
        id: slackMessages.map((s) => s.id),
      },
    });
  } while (slackMessages.length === maxMessages);

  await deleteDataSourceFolder({
    dataSourceConfig,
    folderId: slackChannelInternalIdFromSlackChannelId(channelId),
    loggerArgs,
  });

  logger.info(
    { nbDeleted, ...loggerArgs },
    "Deleted documents from datasource while garbage collecting."
  );
}

export async function deleteChannelsFromConnectorDb(
  channelsToDeleteFromConnectorsDb: string[],
  connectorId: ModelId
) {
  await SlackChannel.destroy({
    where: {
      connectorId: connectorId,
      slackChannelId: {
        [Op.in]: channelsToDeleteFromConnectorsDb,
      },
    },
  });
  logger.info(
    {
      channelsToDeleteFromConnectorsDb,
      connectorId,
    },
    "Deleted channels from connectors db while garbage collecting."
  );
}

export async function attemptChannelJoinActivity(
  connectorId: ModelId,
  channelId: string
) {
  const res = await joinChannel(connectorId, channelId);

  if (res.isErr()) {
    throw res.error;
  }

  const { channel, result } = res.value;
  if (result === "is_archived") {
    logger.info(
      {
        channel,
        connectorId,
      },
      "Channel is archived, skipping sync."
    );
    return false;
  }

  return true;
}
