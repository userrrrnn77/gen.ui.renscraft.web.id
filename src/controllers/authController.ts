// src/controllers/authController.ts

import type { Request, Response } from "express";
import { z } from "zod";
import { env } from "../config/env.js";
import { UserModel } from "../models/User.js";
import { AppError } from "../middleware/error.js";
import { getUserId } from "../middleware/auth.js";
import { signToken, COOKIE_NAME, COOKIE_MAX_AGE_MS } from "../services/auth/tokens.js";

// ─── Schemas ───────────────────────────────────────────────────────────────

const RegisterBody = z.object({
  email: z.string().email().toLowerCase().trim(),
  password: z.string().min(8).max(128),
  name: z.string().min(1).max(80).trim(),
  timezone: z.string().min(1).max(64).optional(),
});

const LoginBody = z.object({
  email: z.string().email().toLowerCase().trim(),
  password: z.string().min(1).max(128),
});

// ─── Helpers ───────────────────────────────────────────────────────────────

function setAuthCookie(res: Response, token: string): void {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure: env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: COOKIE_MAX_AGE_MS,
    path: "/",
  });
}

interface PublicUserInput {
  _id: unknown;
  email: string;
  name: string;
  timezone: string;
}

function publicUser(u: PublicUserInput): {
  id: string;
  email: string;
  name: string;
  timezone: string;
} {
  return {
    id: String(u._id),
    email: u.email,
    name: u.name,
    timezone: u.timezone,
  };
}

// ─── Handlers ──────────────────────────────────────────────────────────────

export async function register(req: Request, res: Response): Promise<void> {
  const body = RegisterBody.parse(req.body);

  const exists = await UserModel.exists({ email: body.email });
  if (exists) throw AppError.conflict("Email already registered");

  const passwordHash = await Bun.password.hash(body.password, {
    algorithm: "argon2id",
  });

  const user = await UserModel.create({
    email: body.email,
    passwordHash,
    name: body.name,
    timezone: body.timezone ?? env.DEFAULT_TIMEZONE,
  });

  const token = await signToken(user._id.toString());
  setAuthCookie(res, token);

  res.status(201).json(publicUser(user));
}

export async function login(req: Request, res: Response): Promise<void> {
  const body = LoginBody.parse(req.body);

  const user = await UserModel.findOne({ email: body.email });
  if (!user) throw AppError.unauthorized("Invalid credentials");

  const ok = await Bun.password.verify(body.password, user.passwordHash);
  if (!ok) throw AppError.unauthorized("Invalid credentials");

  const token = await signToken(user._id.toString());
  setAuthCookie(res, token);

  res.json(publicUser(user));
}

export function logout(_req: Request, res: Response): void {
  res.clearCookie(COOKIE_NAME, { path: "/" });
  res.status(204).end();
}

export async function me(_req: Request, res: Response): Promise<void> {
  const user = await UserModel.findById(getUserId(res)).lean();
  if (!user) throw AppError.unauthorized();
  res.json(publicUser(user));
}
