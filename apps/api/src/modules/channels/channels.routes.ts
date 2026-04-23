import { Router } from "express";
import { requireAuth } from "../../middlewares/auth.middleware";
import { requireChannelMembership } from "../../middlewares/channel-membership.middleware";
import { asyncHandler } from "../../middlewares/error.middleware";
import { messagesRouter } from "../messages/messages.routes";
import {
	acceptChannelInvitation,
	approveChannelJoinRequest,
	createChannel,
	denyChannelJoinRequest,
	discoverChannels,
	getChannelMembers,
	inviteChannelMember,
	joinChannel,
	listChannelJoinRequests,
	listChannels
} from "./channels.controller";

export const channelsRouter = Router();

channelsRouter.use(requireAuth);
channelsRouter.get("/", asyncHandler(listChannels));
channelsRouter.get("/discover", asyncHandler(discoverChannels));
channelsRouter.post("/", asyncHandler(createChannel));
channelsRouter.post("/:channelId/invitations", asyncHandler(inviteChannelMember));
channelsRouter.post("/:channelId/invitations/accept", asyncHandler(acceptChannelInvitation));
channelsRouter.post("/:channelId/join", asyncHandler(joinChannel));
channelsRouter.get("/:channelId/requests", asyncHandler(listChannelJoinRequests));
channelsRouter.post("/:channelId/requests/:requestId/approve", asyncHandler(approveChannelJoinRequest));
channelsRouter.post("/:channelId/requests/:requestId/deny", asyncHandler(denyChannelJoinRequest));
channelsRouter.get("/:channelId/members", requireChannelMembership, asyncHandler(getChannelMembers));
channelsRouter.use("/:channelId/messages", requireChannelMembership, messagesRouter);
