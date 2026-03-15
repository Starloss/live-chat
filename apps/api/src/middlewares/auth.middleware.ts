import type { NextFunction, Request, Response } from "express";
import { verifyAccessToken } from "../modules/auth/auth.utils";

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.header("authorization");

  if (!authHeader?.startsWith("Bearer ")) {
    return res.status(401).json({ message: "Token requerido" });
  }

  const token = authHeader.slice("Bearer ".length).trim();

  try {
    const payload = verifyAccessToken(token);
    req.authUser = {
      id: payload.sub,
      email: payload.email,
      username: payload.username
    };

    return next();
  } catch {
    return res.status(401).json({ message: "Token inválido o expirado" });
  }
}
