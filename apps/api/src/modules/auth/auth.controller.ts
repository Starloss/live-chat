import bcrypt from "bcryptjs";
import type { Request, Response } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { signAccessToken } from "./auth.utils";

const registerSchema = z.object({
  username: z.string().trim().min(3).max(30),
  email: z.string().trim().email(),
  password: z.string().min(8).max(128)
});

const loginSchema = z.object({
  email: z.string().trim().email(),
  password: z.string().min(8).max(128)
});

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
  const accessToken = signAccessToken(userDto);

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
  const accessToken = signAccessToken(userDto);

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
