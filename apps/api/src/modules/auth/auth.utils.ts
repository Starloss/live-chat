import jwt from "jsonwebtoken";
import { env } from "../../config/env";
import type { AuthUserDto, JwtPayload } from "./auth.types";

export function signAccessToken(user: AuthUserDto) {
  const payload: JwtPayload = {
    sub: user.id,
    email: user.email,
    username: user.username
  };

  return jwt.sign(payload, env.jwtSecret, {
    expiresIn: "7d"
  });
}

export function verifyAccessToken(token: string): JwtPayload {
  const decoded = jwt.verify(token, env.jwtSecret);

  if (typeof decoded === "string") {
    throw new Error("Token inválido");
  }

  const payload = decoded as Partial<JwtPayload>;
  if (!payload.sub || !payload.email || !payload.username) {
    throw new Error("Payload JWT inválido");
  }

  return {
    sub: payload.sub,
    email: payload.email,
    username: payload.username
  };
}
