export type ChannelId = string;

export interface ChatMessage {
  id: string;
  channelId: ChannelId;
  authorId: string;
  body: string;
  createdAt: string;
}

export interface UserPresence {
  userId: string;
  status: "online" | "offline";
}
