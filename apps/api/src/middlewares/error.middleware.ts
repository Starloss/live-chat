import type { NextFunction, Request, RequestHandler, Response } from "express";

export function asyncHandler(handler: RequestHandler): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

export function notFoundHandler(_req: Request, res: Response) {
  return res.status(404).json({ message: "Ruta no encontrada" });
}

function getErrorMessage(error: unknown) {
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof (error as { message?: unknown }).message === "string"
  ) {
    return (error as { message: string }).message;
  }

  return "Error interno del servidor";
}

function getErrorStack(error: unknown) {
  if (
    typeof error === "object" &&
    error !== null &&
    "stack" in error &&
    typeof (error as { stack?: unknown }).stack === "string"
  ) {
    return (error as { stack: string }).stack;
  }

  return undefined;
}

export function errorHandler(error: unknown, req: Request, res: Response, _next: NextFunction) {
  const status =
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    typeof (error as { status?: unknown }).status === "number"
      ? (error as { status: number }).status
      : 500;

  const message = getErrorMessage(error);

  if (status >= 500) {
    console.error(
      JSON.stringify({
        level: "error",
        event: "http.request.error",
        status,
        method: req.method,
        path: req.originalUrl,
        message,
        stack: getErrorStack(error),
        timestamp: new Date().toISOString()
      })
    );

    return res.status(status).json({ message: "Error interno del servidor" });
  }

  return res.status(status).json({ message });
}
