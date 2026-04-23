import { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma";

const persistedMessageSelect = {
  id: true,
  channelId: true,
  authorId: true,
  body: true,
  createdAt: true,
  updatedAt: true
} satisfies Prisma.MessageSelect;

export type PersistedMessage = Prisma.MessageGetPayload<{
  select: typeof persistedMessageSelect;
}>;

export interface IdempotentMessageWriteResult {
  message: PersistedMessage;
  deduplicated: boolean;
}

type MessagePersistenceClient = Pick<typeof prisma, "message">;

interface CreateChannelMessageInput {
  channelId: string;
  authorId: string;
  body: string;
  clientMessageId?: string | null;
}

function normalizeClientMessageId(clientMessageId: string | null | undefined) {
  if (typeof clientMessageId !== "string") {
    return null;
  }

  const normalizedClientMessageId = clientMessageId.trim();
  return normalizedClientMessageId.length > 0 ? normalizedClientMessageId : null;
}

async function createMessageWithClientMessageId(
  input: Omit<CreateChannelMessageInput, "clientMessageId"> & { clientMessageId: string },
  client: MessagePersistenceClient
): Promise<IdempotentMessageWriteResult> {
  try {
    const message = await client.message.create({
      data: {
        channelId: input.channelId,
        authorId: input.authorId,
        body: input.body,
        clientMessageId: input.clientMessageId
      },
      select: persistedMessageSelect
    });

    return {
      message,
      deduplicated: false
    };
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") {
      throw error;
    }

    const existingMessage = await client.message.findUnique({
      where: {
        channelId_authorId_clientMessageId: {
          channelId: input.channelId,
          authorId: input.authorId,
          clientMessageId: input.clientMessageId
        }
      },
      select: persistedMessageSelect
    });

    if (existingMessage) {
      return {
        message: existingMessage,
        deduplicated: true
      };
    }

    throw error;
  }
}

export async function createChannelMessageIdempotent(
  input: CreateChannelMessageInput,
  client: MessagePersistenceClient = prisma
): Promise<IdempotentMessageWriteResult> {
  const clientMessageId = normalizeClientMessageId(input.clientMessageId);

  if (!clientMessageId) {
    const message = await client.message.create({
      data: {
        channelId: input.channelId,
        authorId: input.authorId,
        body: input.body
      },
      select: persistedMessageSelect
    });

    return {
      message,
      deduplicated: false
    };
  }

  return createMessageWithClientMessageId(
    {
      channelId: input.channelId,
      authorId: input.authorId,
      body: input.body,
      clientMessageId
    },
    client
  );
}
