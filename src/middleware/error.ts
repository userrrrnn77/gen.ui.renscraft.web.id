// src/middleware/error.ts

export class AppError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }

  static badRequest(msg = "Bad request", details?: unknown): AppError {
    return new AppError("BAD_REQUEST", 400, msg, details);
  }

  static unauthorized(msg = "Unauthorized"): AppError {
    return new AppError("UNAUTHORIZED", 401, msg);
  }

  static forbidden(msg = "Forbidden"): AppError {
    return new AppError("FORBIDDEN", 403, msg);
  }

  static notFound(msg = "Not found"): AppError {
    return new AppError("NOT_FOUND", 404, msg);
  }

  static conflict(msg = "Conflict"): AppError {
    return new AppError("CONFLICT", 409, msg);
  }
}
