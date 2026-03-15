import { prisma } from "../../lib/prisma";

export async function getChannelAccess(userId: string, channelId: string) {
  const channel = await prisma.channel.findUnique({
    where: { id: channelId },
    select: { id: true }
  });

  if (!channel) {
    return {
      channelExists: false,
      membership: null
    };
  }

  const membership = await prisma.channelMember.findFirst({
    where: {
      channelId,
      userId
    },
    select: {
      channelId: true,
      role: true
    }
  });

  return {
    channelExists: true,
    membership
  };
}
