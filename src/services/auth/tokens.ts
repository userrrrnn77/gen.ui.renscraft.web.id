// src/services/auth/tokens.ts

import { SignJWT, jwtVerify } from "jose";
import { env } from "../../config/env.js";

const ALG = "HS256";
const TTL = "7d";

const secret = new TextEncoder().encode(env.JWT_SECRET);

export interface JwtPayload {
  sub: string;
}

export async function signToken(userId: string): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: ALG })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(TTL)
    .sign(secret);
}

export async function verifyToken(token: string): Promise<JwtPayload> {
  const { payload } = await jwtVerify(token, secret, { algorithms: [ALG] });
  if (typeof payload.sub !== "string") {
    throw new Error("Invalid token payload");
  }
  return { sub: payload.sub };
}

export const COOKIE_NAME = "genui_session";
export const COOKIE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
