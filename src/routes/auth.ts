// src/routes/auth.ts

import { Router } from "express";
import { authLimiter } from "../middleware/rateLimit.js";
import { requireAuth } from "../middleware/auth.js";
import { register, login, logout, me } from "../controllers/authController.js";

export const authRouter = Router();

authRouter.post("/register", authLimiter, register);
authRouter.post("/login", authLimiter, login);
authRouter.post("/logout", logout);
authRouter.get("/me", requireAuth, me);
