import bcrypt from "bcryptjs";
import { Prisma } from "@prisma/client";
import type { CookieOptions, Request, Response } from "express";
import { z } from "zod";
import { env } from "../../config/env";
import { prisma } from "../../lib/prisma";
import {
  createRefreshToken,
  hashRefreshToken,
  refreshTokenExpiresAt,
  refreshTokenMaxAgeMs,
  signAccessToken
} from "./auth.utils";

const registerSchema = z.object({
  username: z.string().trim().min(3).max(30),
  email: z.string().trim().email(),
  password: z.string().min(8).max(128)
});

const loginSchema = z.object({
  email: z.string().trim().email(),
  password: z.string().min(8).max(128)
});

const REFRESH_COOKIE_PATH = "/api/auth";

type RefreshTokenClient = Pick<typeof prisma, "refreshToken">;

function refreshCookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    secure: env.isProduction,
    sameSite: env.refreshTokenCookieSameSite,
    path: REFRESH_COOKIE_PATH,
    maxAge: refreshTokenMaxAgeMs()
  };
}

function clearRefreshCookie(res: Response) {
  res.clearCookie(env.refreshTokenCookieName, {
    httpOnly: true,
    secure: env.isProduction,
    sameSite: env.refreshTokenCookieSameSite,
    path: REFRESH_COOKIE_PATH
  });
}

function setRefreshCookie(res: Response, refreshToken: string) {
  res.cookie(env.refreshTokenCookieName, refreshToken, refreshCookieOptions());
}

function parseCookies(cookieHeader: string | undefined) {
  if (!cookieHeader) {
    return {} as Record<string, string>;
  }

  return cookieHeader
    .split(";")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .reduce<Record<string, string>>((accumulator, cookieEntry) => {
      const separatorIndex = cookieEntry.indexOf("=");
      if (separatorIndex <= 0) {
        return accumulator;
      }

      const key = cookieEntry.slice(0, separatorIndex).trim();
      const rawValue = cookieEntry.slice(separatorIndex + 1).trim();

      if (!key) {
        return accumulator;
      }

      try {
        accumulator[key] = decodeURIComponent(rawValue);
      } catch {
        accumulator[key] = rawValue;
      }

      return accumulator;
    }, {});
}

function getRefreshTokenFromRequest(req: Request) {
  const cookieHeader = req.header("cookie");
  const cookies = parseCookies(cookieHeader);
  const refreshToken = cookies[env.refreshTokenCookieName];

  return typeof refreshToken === "string" && refreshToken.trim() ? refreshToken : null;
}

async function createRefreshTokenRecord(userId: string, client: RefreshTokenClient = prisma) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const refreshToken = createRefreshToken();
    const tokenHash = hashRefreshToken(refreshToken);

    try {
      await client.refreshToken.create({
        data: {
          userId,
          tokenHash,
          expiresAt: refreshTokenExpiresAt()
        }
      });

      return refreshToken;
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") {
        throw error;
      }
    }
  }

  throw new Error("No se pudo crear una sesión de refresh token");
}

async function revokeActiveRefreshSessions(
  userId: string,
  revokedAt: Date,
  client: RefreshTokenClient = prisma
) {
  await client.refreshToken.updateMany({
    where: {
      userId,
      revokedAt: null
    },
    data: {
      revokedAt
    }
  });
}

async function issueSession(res: Response, user: { id: string; email: string; username: string }) {
  const refreshToken = await createRefreshTokenRecord(user.id);
  const accessToken = signAccessToken(toUserDto(user));

  setRefreshCookie(res, refreshToken);

  return accessToken;
}

function toUserDto(user: { id: string; email: string; username: string }) {
  return {
    id: user.id,
    email: user.email,
    username: user.username
  };
}

export async function register(req: Request, res: Response) {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: "Payload inválido" });
  }

  const { username, email, password } = parsed.data;

  const existingUser = await prisma.user.findFirst({
    where: {
      OR: [{ email }, { username }]
    },
    select: { id: true }
  });

  if (existingUser) {
    return res.status(409).json({ message: "Usuario o email ya existe" });
  }

  const passwordHash = await bcrypt.hash(password, 12);

  const user = await prisma.user.create({
    data: {
      username,
      email,
      passwordHash
    },
    select: {
      id: true,
      email: true,
      username: true
    }
  });

  await prisma.userPresence.create({
    data: {
      userId: user.id,
      status: "OFFLINE"
    }
  });

  const userDto = toUserDto(user);
  const accessToken = await issueSession(res, userDto);

  return res.status(201).json({
    user: userDto,
    accessToken
  });
}

export async function login(req: Request, res: Response) {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: "Payload inválido" });
  }

  const { email, password } = parsed.data;

  const user = await prisma.user.findUnique({
    where: { email },
    select: {
      id: true,
      email: true,
      username: true,
      passwordHash: true
    }
  });

  if (!user) {
    return res.status(401).json({ message: "Credenciales inválidas" });
  }

  const isValidPassword = await bcrypt.compare(password, user.passwordHash);
  if (!isValidPassword) {
    return res.status(401).json({ message: "Credenciales inválidas" });
  }

  const userDto = toUserDto(user);
  const accessToken = await issueSession(res, userDto);

  return res.status(200).json({
    user: userDto,
    accessToken
  });
}

export async function me(req: Request, res: Response) {
  if (!req.authUser) {
    return res.status(401).json({ message: "No autenticado" });
  }

  const user = await prisma.user.findUnique({
    where: { id: req.authUser.id },
    select: {
      id: true,
      email: true,
      username: true
    }
  });

  if (!user) {
    return res.status(404).json({ message: "Usuario no encontrado" });
  }

  return res.status(200).json({ user: toUserDto(user) });
}

export async function refresh(req: Request, res: Response) {
  const currentRefreshToken = getRefreshTokenFromRequest(req);
  if (!currentRefreshToken) {
    clearRefreshCookie(res);
    return res.status(401).json({ message: "Sesión inválida" });
  }

  const currentTokenHash = hashRefreshToken(currentRefreshToken);
  const now = new Date();

  const rotatedSession = await prisma.$transaction(async (transaction) => {
    const persistedToken = await transaction.refreshToken.findUnique({
      where: {
        tokenHash: currentTokenHash
      },
      select: {
        id: true,
        userId: true,
        expiresAt: true,
        revokedAt: true,
        user: {
          select: {
            id: true,
            email: true,
            username: true
          }
        }
      }
    });

    if (!persistedToken) {
      return { status: "invalid" } as const;
    }

    if (persistedToken.revokedAt) {
      await revokeActiveRefreshSessions(persistedToken.userId, now, transaction);
      return { status: "invalid" } as const;
    }

    if (persistedToken.expiresAt <= now) {
      await transaction.refreshToken.updateMany({
        where: {
          id: persistedToken.id,
          revokedAt: null
        },
        data: {
          revokedAt: now
        }
      });

      return { status: "invalid" } as const;
    }

    const consumeResult = await transaction.refreshToken.updateMany({
      where: {
        id: persistedToken.id,
        revokedAt: null,
        expiresAt: {
          gt: now
        }
      },
      data: {
        revokedAt: now
      }
    });

    if (consumeResult.count !== 1) {
      const tokenAfterConsumeAttempt = await transaction.refreshToken.findUnique({
        where: {
          id: persistedToken.id
        },
        select: {
          userId: true,
          expiresAt: true,
          revokedAt: true
        }
      });

      if (tokenAfterConsumeAttempt?.revokedAt) {
        await revokeActiveRefreshSessions(tokenAfterConsumeAttempt.userId, now, transaction);
      } else if (tokenAfterConsumeAttempt && tokenAfterConsumeAttempt.expiresAt <= now) {
        await transaction.refreshToken.updateMany({
          where: {
            id: persistedToken.id,
            revokedAt: null
          },
          data: {
            revokedAt: now
          }
        });
      }

      return { status: "invalid" } as const;
    }

    const nextRefreshToken = await createRefreshTokenRecord(persistedToken.userId, transaction);

    return {
      status: "rotated",
      user: persistedToken.user,
      refreshToken: nextRefreshToken
    } as const;
  });

  if (rotatedSession.status !== "rotated") {
    clearRefreshCookie(res);
    return res.status(401).json({ message: "Sesión inválida" });
  }

  setRefreshCookie(res, rotatedSession.refreshToken);

  const userDto = toUserDto(rotatedSession.user);
  const accessToken = signAccessToken(userDto);

  return res.status(200).json({
    user: userDto,
    accessToken
  });
}

export async function logout(req: Request, res: Response) {
  const currentRefreshToken = getRefreshTokenFromRequest(req);

  if (currentRefreshToken) {
    const tokenHash = hashRefreshToken(currentRefreshToken);

    await prisma.refreshToken.updateMany({
      where: {
        tokenHash,
        revokedAt: null
      },
      data: {
        revokedAt: new Date()
      }
    });
  }

  clearRefreshCookie(res);
  return res.status(200).json({ message: "Sesión cerrada" });
}
