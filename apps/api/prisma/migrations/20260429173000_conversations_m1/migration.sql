-- CreateEnum
CREATE TYPE "ConversationType" AS ENUM ('CHANNEL', 'DIRECT');

-- CreateTable
CREATE TABLE "Conversation" (
    "id" TEXT NOT NULL,
    "type" "ConversationType" NOT NULL,
    "channelId" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Conversation_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Conversation_type_channel_consistency_chk" CHECK (
      (
        "type" = 'CHANNEL'::"ConversationType"
        AND "channelId" IS NOT NULL
      )
      OR (
        "type" = 'DIRECT'::"ConversationType"
        AND "channelId" IS NULL
      )
    )
);

-- CreateTable
CREATE TABLE "ConversationParticipant" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "ChannelRole" NOT NULL DEFAULT 'MEMBER',
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConversationParticipant_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "Message" ADD COLUMN "conversationId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Conversation_channelId_key" ON "Conversation"("channelId");

-- CreateIndex
CREATE INDEX "Conversation_type_createdAt_idx" ON "Conversation"("type", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "Conversation_createdById_idx" ON "Conversation"("createdById");

-- CreateIndex
CREATE UNIQUE INDEX "ConversationParticipant_conversationId_userId_key" ON "ConversationParticipant"("conversationId", "userId");

-- CreateIndex
CREATE INDEX "ConversationParticipant_userId_idx" ON "ConversationParticipant"("userId");

-- CreateIndex
CREATE INDEX "Message_conversationId_createdAt_idx" ON "Message"("conversationId", "createdAt" DESC);

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "Channel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationParticipant" ADD CONSTRAINT "ConversationParticipant_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationParticipant" ADD CONSTRAINT "ConversationParticipant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill CHANNEL wrappers for all existing channels.
INSERT INTO "Conversation" (
    "id",
    "type",
    "channelId",
    "createdById",
    "createdAt",
    "updatedAt"
)
SELECT
    CONCAT('conv_channel_', c."id"),
    'CHANNEL'::"ConversationType",
    c."id",
    c."createdById",
    c."createdAt",
    c."createdAt"
FROM "Channel" AS c
ON CONFLICT ("channelId") DO NOTHING;

-- Backfill participants from existing channel memberships.
INSERT INTO "ConversationParticipant" (
    "id",
    "conversationId",
    "userId",
    "role",
    "joinedAt"
)
SELECT
    CONCAT('conv_participant_', cm."id"),
    conv."id",
    cm."userId",
    cm."role",
    cm."joinedAt"
FROM "ChannelMember" AS cm
INNER JOIN "Conversation" AS conv
    ON conv."channelId" = cm."channelId"
ON CONFLICT ("conversationId", "userId")
DO UPDATE SET
    "role" = EXCLUDED."role";

-- Backfill message linkage to conversation wrappers.
UPDATE "Message" AS m
SET "conversationId" = conv."id"
FROM "Conversation" AS conv
WHERE m."conversationId" IS NULL
  AND conv."channelId" = m."channelId";

-- Keep wrapper conversations in sync for channels created via legacy API.
CREATE OR REPLACE FUNCTION "sync_channel_conversation_wrapper_fn"()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO "Conversation" (
      "id",
      "type",
      "channelId",
      "createdById",
      "createdAt",
      "updatedAt"
  )
  VALUES (
      CONCAT('conv_channel_', NEW."id"),
      'CHANNEL'::"ConversationType",
      NEW."id",
      NEW."createdById",
      NEW."createdAt",
      COALESCE(NEW."createdAt", CURRENT_TIMESTAMP)
  )
  ON CONFLICT ("channelId") DO NOTHING;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "sync_channel_conversation_wrapper_trg"
AFTER INSERT ON "Channel"
FOR EACH ROW
EXECUTE FUNCTION "sync_channel_conversation_wrapper_fn"();

-- Keep participants mirrored when legacy channel membership writes occur.
CREATE OR REPLACE FUNCTION "sync_channel_member_conversation_participant_fn"()
RETURNS TRIGGER AS $$
DECLARE
  wrapper_conversation_id TEXT;
BEGIN
  SELECT conv."id"
  INTO wrapper_conversation_id
  FROM "Conversation" AS conv
  WHERE conv."channelId" = NEW."channelId"
  LIMIT 1;

  IF wrapper_conversation_id IS NULL THEN
    RETURN NEW;
  END IF;

  INSERT INTO "ConversationParticipant" (
      "id",
      "conversationId",
      "userId",
      "role",
      "joinedAt"
  )
  VALUES (
      CONCAT('conv_participant_', NEW."id"),
      wrapper_conversation_id,
      NEW."userId",
      NEW."role",
      NEW."joinedAt"
  )
  ON CONFLICT ("conversationId", "userId")
  DO UPDATE SET
      "role" = EXCLUDED."role";

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "sync_channel_member_conversation_participant_trg"
AFTER INSERT ON "ChannelMember"
FOR EACH ROW
EXECUTE FUNCTION "sync_channel_member_conversation_participant_fn"();

-- Keep message->conversation linkage populated while legacy writers still send channelId only.
CREATE OR REPLACE FUNCTION "sync_message_conversation_id_from_channel_fn"()
RETURNS TRIGGER AS $$
DECLARE
  wrapper_conversation_id TEXT;
BEGIN
  IF NEW."conversationId" IS NOT NULL THEN
    RETURN NEW;
  END IF;

  SELECT conv."id"
  INTO wrapper_conversation_id
  FROM "Conversation" AS conv
  WHERE conv."channelId" = NEW."channelId"
  LIMIT 1;

  IF wrapper_conversation_id IS NOT NULL THEN
    NEW."conversationId" = wrapper_conversation_id;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "sync_message_conversation_id_from_channel_trg"
BEFORE INSERT ON "Message"
FOR EACH ROW
EXECUTE FUNCTION "sync_message_conversation_id_from_channel_fn"();
