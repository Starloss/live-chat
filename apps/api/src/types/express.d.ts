declare namespace Express {
  interface Request {
    authUser?: {
      id: string;
      email: string;
      username: string;
    };
    channelAccess?: {
      channelId: string;
      role: "OWNER" | "MEMBER";
    };
  }
}
