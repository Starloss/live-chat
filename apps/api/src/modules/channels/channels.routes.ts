import { Router } from "express";
import { requireAuth } from "../../middlewares/auth.middleware";
import { requireChannelMembership } from "../../middlewares/channel-membership.middleware";
import { asyncHandler } from "../../middlewares/error.middleware";
import { messagesRouter } from "../messages/messages.routes";
import { createChannel, getChannelMembers, joinChannel, listChannels } from "./channels.controller";

export const channelsRouter = Router();

channelsRouter.use(requireAuth);
channelsRouter.get("/", asyncHandler(listChannels));
channelsRouter.post("/", asyncHandler(createChannel));
channelsRouter.post("/:channelId/join", asyncHandler(joinChannel));
channelsRouter.get("/:channelId/members", requireChannelMembership, asyncHandler(getChannelMembers));
channelsRouter.use("/:channelId/messages", requireChannelMembership, messagesRouter);
