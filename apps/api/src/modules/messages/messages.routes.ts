import { Router } from "express";
import { asyncHandler } from "../../middlewares/error.middleware";
import { createChannelMessage, listChannelMessages } from "./messages.controller";

export const messagesRouter = Router({ mergeParams: true });

messagesRouter.get("/", asyncHandler(listChannelMessages));
messagesRouter.post("/", asyncHandler(createChannelMessage));
