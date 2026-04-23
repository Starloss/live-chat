-- AlterTable
ALTER TABLE "Message" ADD COLUMN "clientMessageId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Message_channelId_authorId_clientMessageId_key"
ON "Message"("channelId", "authorId", "clientMessageId");
