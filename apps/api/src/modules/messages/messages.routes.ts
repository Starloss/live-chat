import { Router } from "express";
import { asyncHandler } from "../../middlewares/error.middleware";
import {
	createChannelMessage,
	listChannelMessages,
	markMessageReceipt
} from "./messages.controller";

export const messagesRouter = Router({ mergeParams: true });

messagesRouter.get("/", asyncHandler(listChannelMessages));
messagesRouter.post("/", asyncHandler(createChannelMessage));
messagesRouter.post("/:messageId/receipt", asyncHandler(markMessageReceipt));
