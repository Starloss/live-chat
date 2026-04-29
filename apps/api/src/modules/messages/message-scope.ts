import { env } from "../../config/env";
import { prisma } from "../../lib/prisma";
import { getChannelAccess } from "../channels/channel-access";

function normalizeIdentifier(value: string | null | undefined) {
  if (typeof value !== "string") {
    return null;
  }

  const normalizedValue = value.trim();
  return normalizedValue.length > 0 ? normalizedValue : null;
}

export interface MessageScopeResolution {
  channelId: string;
  conversationId: string | null;
  source: "conversation" | "channel";
}

export type MessageScopeResolutionErrorCode =
  | "MISSING_SCOPE"
  | "CHANNEL_NOT_FOUND"
  | "CHANNEL_FORBIDDEN"
  | "CONVERSATION_NOT_FOUND"
  | "CONVERSATION_FORBIDDEN"
  | "UNSUPPORTED_CONVERSATION"
  | "CHANNEL_CONVERSATION_MISMATCH";

export type MessageScopeResolutionResult =
  | {
      ok: true;
      value: MessageScopeResolution;
    }
  | {
      ok: false;
      code: MessageScopeResolutionErrorCode;
    };

interface ResolveMessageScopeInput {
  userId: string;
  channelId?: string | null;
  conversationId?: string | null;
}

async function ensureChannelWrapperConversation(channelId: string) {
  const existingConversation = await prisma.conversation.findUnique({
    where: {
      channelId
    },
    select: {
      id: true
    }
  });

  if (existingConversation) {
    return existingConversation.id;
  }

  const channel = await prisma.channel.findUnique({
    where: {
      id: channelId
    },
    select: {
      id: true,
      createdById: true
    }
  });

  if (!channel) {
    return null;
  }

  return prisma.$transaction(async (transaction) => {
    const conversation = await transaction.conversation.upsert({
      where: {
        channelId
      },
      update: {},
      create: {
        type: "CHANNEL",
        channelId,
        createdById: channel.createdById
      },
      select: {
        id: true
      }
    });

    const channelMembers = await transaction.channelMember.findMany({
      where: {
        channelId
      },
      select: {
        userId: true,
        role: true,
        joinedAt: true
      }
    });

    if (channelMembers.length > 0) {
      await transaction.conversationParticipant.createMany({
        data: channelMembers.map((member) => ({
          conversationId: conversation.id,
          userId: member.userId,
          role: member.role,
          joinedAt: member.joinedAt
        })),
        skipDuplicates: true
      });
    }

    return conversation.id;
  });
}

async function resolveFromConversation(input: {
  userId: string;
  conversationId: string;
  channelId: string | null;
}): Promise<MessageScopeResolutionResult> {
  const conversation = await prisma.conversation.findUnique({
    where: {
      id: input.conversationId
    },
    select: {
      id: true,
      channelId: true,
      participants: {
        where: {
          userId: input.userId
        },
        select: {
          id: true
        },
        take: 1
      }
    }
  });

  if (!conversation) {
    return {
      ok: false,
      code: "CONVERSATION_NOT_FOUND"
    };
  }

  let hasConversationAccess = conversation.participants.length > 0;
  if (!hasConversationAccess && conversation.channelId) {
    const channelAccess = await getChannelAccess(input.userId, conversation.channelId);
    hasConversationAccess = Boolean(channelAccess.membership);
  }

  if (!hasConversationAccess) {
    return {
      ok: false,
      code: "CONVERSATION_FORBIDDEN"
    };
  }

  if (!conversation.channelId) {
    return {
      ok: false,
      code: "UNSUPPORTED_CONVERSATION"
    };
  }

  if (input.channelId && input.channelId !== conversation.channelId) {
    return {
      ok: false,
      code: "CHANNEL_CONVERSATION_MISMATCH"
    };
  }

  return {
    ok: true,
    value: {
      channelId: conversation.channelId,
      conversationId: conversation.id,
      source: "conversation"
    }
  };
}

export async function resolveMessageScopeForUser(
  input: ResolveMessageScopeInput
): Promise<MessageScopeResolutionResult> {
  const normalizedChannelId = normalizeIdentifier(input.channelId);
  const normalizedConversationId = normalizeIdentifier(input.conversationId);

  if (env.conversationFirstDualWriteEnabled && normalizedConversationId) {
    return resolveFromConversation({
      userId: input.userId,
      conversationId: normalizedConversationId,
      channelId: normalizedChannelId
    });
  }

  if (!normalizedChannelId) {
    return {
      ok: false,
      code: "MISSING_SCOPE"
    };
  }

  const channelAccess = await getChannelAccess(input.userId, normalizedChannelId);

  if (!channelAccess.channelExists) {
    return {
      ok: false,
      code: "CHANNEL_NOT_FOUND"
    };
  }

  if (!channelAccess.membership) {
    return {
      ok: false,
      code: "CHANNEL_FORBIDDEN"
    };
  }

  const conversationId = env.conversationFirstDualWriteEnabled
    ? await ensureChannelWrapperConversation(normalizedChannelId)
    : null;

  if (env.conversationFirstDualWriteEnabled && !conversationId) {
    return {
      ok: false,
      code: "CHANNEL_NOT_FOUND"
    };
  }

  return {
    ok: true,
    value: {
      channelId: normalizedChannelId,
      conversationId,
      source: "channel"
    }
  };
}
