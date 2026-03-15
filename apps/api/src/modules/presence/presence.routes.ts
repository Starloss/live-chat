import { Router } from "express";
import { requireAuth } from "../../middlewares/auth.middleware";
import { asyncHandler } from "../../middlewares/error.middleware";
import { listPresenceByChannel } from "./presence.controller";

export const presenceRouter = Router();

presenceRouter.use(requireAuth);
presenceRouter.get("/", asyncHandler(listPresenceByChannel));
