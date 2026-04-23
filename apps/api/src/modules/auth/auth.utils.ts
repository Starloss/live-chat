import { createHash, randomBytes } from "node:crypto";
import jwt from "jsonwebtoken";
import { env } from "../../config/env";
import type { AccessTokenClaims, AuthUserDto, JwtPayload } from "./auth.types";

function toSeconds(days: number) {
  return days * 24 * 60 * 60;
}

export function signAccessToken(user: AuthUserDto) {
  const payload: AccessTokenClaims = {
    sub: user.id,
    email: user.email,
    username: user.username
  };

  return jwt.sign(payload, env.jwtSecret, {
    expiresIn: `${env.accessTokenTtlMinutes}m`
  });
}

export function createRefreshToken() {
  return randomBytes(48).toString("base64url");
}

export function hashRefreshToken(refreshToken: string) {
  return createHash("sha256").update(refreshToken).digest("hex");
}

export function refreshTokenMaxAgeMs() {
  return toSeconds(env.refreshTokenTtlDays) * 1000;
}

export function refreshTokenExpiresAt() {
  return new Date(Date.now() + refreshTokenMaxAgeMs());
}

export function verifyAccessToken(token: string): JwtPayload {
  const decoded = jwt.verify(token, env.jwtSecret);

  if (typeof decoded === "string") {
    throw new Error("Token inválido");
  }

  const payload = decoded as Partial<JwtPayload>;
  if (
    !payload.sub ||
    !payload.email ||
    !payload.username ||
    typeof payload.exp !== "number" ||
    !Number.isFinite(payload.exp)
  ) {
    throw new Error("Payload JWT inválido");
  }

  return {
    sub: payload.sub,
    email: payload.email,
    username: payload.username,
    exp: payload.exp
  };
}
