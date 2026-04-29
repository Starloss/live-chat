import { Router } from "express";
import { requireAuth } from "../../middlewares/auth.middleware";
import { asyncHandler } from "../../middlewares/error.middleware";
import {
  createConversationMessage,
  listConversationMessages
} from "./messages.controller";

export const conversationMessagesRouter = Router();

conversationMessagesRouter.use(requireAuth);
conversationMessagesRouter.get("/:conversationId/messages", asyncHandler(listConversationMessages));
conversationMessagesRouter.post("/:conversationId/messages", asyncHandler(createConversationMessage));
