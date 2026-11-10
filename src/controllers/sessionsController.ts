// src/controllers/sessionsController.ts

import type { Request, Response } from "express";
import { z } from "zod";
import { SessionModel } from "../models/Session.js";
import { MessageModel } from "../models/Message.js";
import { FileDocModel } from "../models/FileDoc.js";
import { ChunkModel } from "../models/Chunk.js";
import { ToolRunModel } from "../models/ToolRun.js";
import { AppError } from "../middleware/error.js";
import { getUserId } from "../middleware/auth.js";
import { parseObjectIdParam as parseSessionId } from "../utils/params.js";
import { getStorage } from "../storage/index.js";
import { logger } from "../config/logger.js";

// ─── Schemas ───────────────────────────────────────────────────────────────

const CreateBody = z.object({
  title: z.string().min(1).max(200).trim().optional(),
});

const PatchBody = z.object({
  title: z.string().min(1).max(200).trim().optional(),
  pinned: z.boolean().optional(),
  archived: z.boolean().optional(),
});

const ListQuery = z.object({
  cursor: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

const GetQuery = z.object({
  cursor: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

// ─── Helpers ───────────────────────────────────────────────────────────────

interface SessionLike {
  _id: unknown;
  title: string;
  pinned: boolean;
  archived: boolean;
  lastMessageAt?: Date | null;
  createdAt: Date;
}

function serializeSession(s: SessionLike): {
  id: string;
  title: string;
  pinned: boolean;
  archived: boolean;
  lastMessageAt: string | null;
  createdAt: string;
} {
  return {
    id: String(s._id),
    title: s.title,
    pinned: s.pinned,
    archived: s.archived,
    lastMessageAt: s.lastMessageAt?.toISOString() ?? null,
    createdAt: s.createdAt.toISOString(),
  };
}

// ─── Handlers ──────────────────────────────────────────────────────────────

export async function listSessions(req: Request, res: Response): Promise<void> {
  const q = ListQuery.parse(req.query);
  const userId = getUserId(res);

  const filter: Record<string, unknown> = { userId, archived: false };
  if (q.cursor) filter.lastMessageAt = { $lt: new Date(q.cursor) };

  const items = await SessionModel.find(filter)
    .sort({ lastMessageAt: -1, _id: -1 })
    .limit(q.limit + 1)
    .lean();

  const hasMore = items.length > q.limit;
  const page = hasMore ? items.slice(0, q.limit) : items;
  const last = page[page.length - 1];
  const nextCursor =
    hasMore && last?.lastMessageAt ? last.lastMessageAt.toISOString() : null;

  res.json({ items: page.map(serializeSession), nextCursor });
}

export async function createSession(
  req: Request,
  res: Response,
): Promise<void> {
  const body = CreateBody.parse(req.body);
  const s = await SessionModel.create({
    userId: getUserId(res),
    title: body.title ?? "New Chat",
    titleAuto: body.title === undefined,
  });
  res.status(201).json(serializeSession(s));
}

export async function getSession(req: Request, res: Response): Promise<void> {
  const id = parseSessionId(req.params.id);
  const q = GetQuery.parse(req.query);
  const userId = getUserId(res);

  const session = await SessionModel.findOne({ _id: id, userId }).lean();
  if (!session) throw AppError.notFound();

  const msgFilter: Record<string, unknown> = { sessionId: session._id };
  if (q.cursor) msgFilter.createdAt = { $lt: new Date(q.cursor) };

  const msgs = await MessageModel.find(msgFilter)
    .sort({ createdAt: -1 })
    .limit(q.limit + 1)
    .lean();

  const hasMore = msgs.length > q.limit;
  const page = hasMore ? msgs.slice(0, q.limit) : msgs;
  page.reverse();
  const nextCursor =
    hasMore && page[0]?.createdAt ? page[0].createdAt.toISOString() : null;

  res.json({
    session: {
      ...serializeSession(session),
      summary: session.summary,
    },
    messages: page.map((m) => ({
      id: String(m._id),
      role: m.role,
      blocks: m.blocks,
      status: m.status,
      createdAt: m.createdAt.toISOString(),
    })),
    nextCursor,
  });
}

export async function patchSession(req: Request, res: Response): Promise<void> {
  const id = parseSessionId(req.params.id);
  const body = PatchBody.parse(req.body);

  const update: Record<string, unknown> = {};
  if (body.title !== undefined) {
    update.title = body.title;
    update.titleAuto = false;
  }
  if (body.pinned !== undefined) update.pinned = body.pinned;
  if (body.archived !== undefined) update.archived = body.archived;

  if (Object.keys(update).length === 0) {
    throw AppError.badRequest("No fields to update");
  }

  const s = await SessionModel.findOneAndUpdate(
    { _id: id, userId: getUserId(res) },
    update,
    { new: true },
  ).lean();
  if (!s) throw AppError.notFound();

  res.json(serializeSession(s));
}

export async function deleteSession(
  req: Request,
  res: Response,
): Promise<void> {
  const id = parseSessionId(req.params.id);

  const session = await SessionModel.findOne({
    _id: id,
    userId: getUserId(res),
  }).lean();
  if (!session) throw AppError.notFound();

  const files = await FileDocModel.find({ sessionId: session._id })
    .select({ storage: 1 })
    .lean();

  const storage = getStorage();
  await Promise.all(
    files.map((f) =>
      storage.delete(f.storage.key).catch((err: unknown) => {
        logger.warn(
          { err, key: f.storage.key },
          "r2 delete failed during session cleanup",
        );
      }),
    ),
  );

  await Promise.all([
    MessageModel.deleteMany({ sessionId: session._id }),
    FileDocModel.deleteMany({ sessionId: session._id }),
    ChunkModel.deleteMany({ sessionId: session._id }),
    ToolRunModel.deleteMany({ sessionId: session._id }),
    SessionModel.deleteOne({ _id: session._id }),
  ]);

  res.status(204).end();
}
