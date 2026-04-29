import type { NextFunction, Request, Response } from "express";
import { getChannelAccess } from "../modules/channels/channel-access";

export async function requireChannelMembership(req: Request, res: Response, next: NextFunction) {
  const userId = req.authUser?.id;
  const channelId = req.params.channelId?.trim();

  if (!userId) {
    return res.status(401).json({ message: "No autenticado" });
  }

  if (!channelId) {
    return res.status(400).json({ message: "Parámetros inválidos" });
  }

  const access = await getChannelAccess(userId, channelId);

  if (!access.channelExists) {
    return res.status(404).json({ message: "Canal no encontrado" });
  }

  if (!access.membership) {
    return res.status(404).json({ message: "Canal no encontrado" });
  }

  req.channelAccess = {
    channelId: access.membership.channelId,
    role: access.membership.role
  };

  return next();
}
