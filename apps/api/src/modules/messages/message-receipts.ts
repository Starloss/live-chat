import { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma";

export type MessageReceiptStatus = "DELIVERED" | "READ";

export const messageReceiptSelect = {
  id: true,
  messageId: true,
  userId: true,
  deliveredAt: true,
  readAt: true,
  createdAt: true,
  updatedAt: true
} satisfies Prisma.MessageReceiptSelect;

export type PersistedMessageReceipt = Prisma.MessageReceiptGetPayload<{
  select: typeof messageReceiptSelect;
}>;

export interface MessageReceiptState {
  id: string;
  messageId: string;
  userId: string;
  status: MessageReceiptStatus;
  deliveredAt: Date;
  readAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ApplyMessageReceiptInput {
  channelId: string;
  messageId: string;
  userId: string;
  status: MessageReceiptStatus;
}

export class MessageReceiptTransitionError extends Error {
  constructor(public readonly code: "MESSAGE_NOT_FOUND") {
    super("Mensaje no encontrado");
    this.name = "MessageReceiptTransitionError";
  }
}

function deriveReceiptStatus(receipt: Pick<PersistedMessageReceipt, "readAt">): MessageReceiptStatus {
  return receipt.readAt ? "READ" : "DELIVERED";
}

function normalizeDeliveredAt(receipt: PersistedMessageReceipt) {
  return receipt.deliveredAt ?? receipt.readAt ?? receipt.updatedAt;
}

export function toMessageReceiptState(receipt: PersistedMessageReceipt | null | undefined) {
  if (!receipt) {
    return null;
  }

  return {
    id: receipt.id,
    messageId: receipt.messageId,
    userId: receipt.userId,
    status: deriveReceiptStatus(receipt),
    deliveredAt: normalizeDeliveredAt(receipt),
    readAt: receipt.readAt,
    createdAt: receipt.createdAt,
    updatedAt: receipt.updatedAt
  } satisfies MessageReceiptState;
}

interface MessageReceiptPersistenceClient {
  $transaction<T>(handler: (transaction: Prisma.TransactionClient) => Promise<T>): Promise<T>;
}

async function assertMessageInChannel(
  transaction: Prisma.TransactionClient,
  channelId: string,
  messageId: string
) {
  const message = await transaction.message.findUnique({
    where: {
      id: messageId
    },
    select: {
      id: true,
      channelId: true,
      deletedAt: true
    }
  });

  if (!message || message.channelId !== channelId || message.deletedAt) {
    throw new MessageReceiptTransitionError("MESSAGE_NOT_FOUND");
  }
}

export async function applyMessageReceiptTransition(
  input: ApplyMessageReceiptInput,
  client: MessageReceiptPersistenceClient = prisma
): Promise<MessageReceiptState> {
  return client.$transaction(async (transaction) => {
    await assertMessageInChannel(transaction, input.channelId, input.messageId);

    const now = new Date();
    const receiptWhere = {
      messageId_userId: {
        messageId: input.messageId,
        userId: input.userId
      }
    } as const;

    if (input.status === "DELIVERED") {
      await transaction.messageReceipt.upsert({
        where: receiptWhere,
        update: {},
        create: {
          messageId: input.messageId,
          userId: input.userId,
          deliveredAt: now
        }
      });

      await transaction.messageReceipt.updateMany({
        where: {
          messageId: input.messageId,
          userId: input.userId,
          deliveredAt: null
        },
        data: {
          deliveredAt: now
        }
      });
    }

    if (input.status === "READ") {
      await transaction.messageReceipt.upsert({
        where: receiptWhere,
        update: {},
        create: {
          messageId: input.messageId,
          userId: input.userId,
          deliveredAt: now,
          readAt: now
        }
      });

      await transaction.messageReceipt.updateMany({
        where: {
          messageId: input.messageId,
          userId: input.userId,
          deliveredAt: null
        },
        data: {
          deliveredAt: now
        }
      });

      await transaction.messageReceipt.updateMany({
        where: {
          messageId: input.messageId,
          userId: input.userId,
          readAt: null
        },
        data: {
          readAt: now
        }
      });
    }

    const persistedReceipt = await transaction.messageReceipt.findUnique({
      where: receiptWhere,
      select: messageReceiptSelect
    });

    const normalizedReceipt = toMessageReceiptState(persistedReceipt);
    if (!normalizedReceipt) {
      throw new Error("No se pudo persistir el receipt de mensaje");
    }

    return normalizedReceipt;
  });
}
