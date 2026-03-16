-- CreateEnum
CREATE TYPE "ChannelVisibility" AS ENUM ('PUBLIC', 'PRIVATE');

-- CreateEnum
CREATE TYPE "ChannelRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'DENIED');

-- AlterTable
ALTER TABLE "Channel" ADD COLUMN     "visibility" "ChannelVisibility" NOT NULL DEFAULT 'PUBLIC';

-- CreateTable
CREATE TABLE "ChannelJoinRequest" (
    "id" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "ChannelRequestStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChannelJoinRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ChannelJoinRequest_channelId_status_idx" ON "ChannelJoinRequest"("channelId", "status");

-- CreateIndex
CREATE INDEX "ChannelJoinRequest_userId_status_idx" ON "ChannelJoinRequest"("userId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ChannelJoinRequest_channelId_userId_key" ON "ChannelJoinRequest"("channelId", "userId");

-- AddForeignKey
ALTER TABLE "ChannelJoinRequest" ADD CONSTRAINT "ChannelJoinRequest_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "Channel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChannelJoinRequest" ADD CONSTRAINT "ChannelJoinRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
