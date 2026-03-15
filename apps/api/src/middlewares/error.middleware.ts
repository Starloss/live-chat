import type { NextFunction, Request, RequestHandler, Response } from "express";

export function asyncHandler(handler: RequestHandler): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

export function notFoundHandler(_req: Request, res: Response) {
  return res.status(404).json({ message: "Ruta no encontrada" });
}

export function errorHandler(error: unknown, _req: Request, res: Response, _next: NextFunction) {
  const status =
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    typeof (error as { status?: unknown }).status === "number"
      ? (error as { status: number }).status
      : 500;

  const message =
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof (error as { message?: unknown }).message === "string"
      ? (error as { message: string }).message
      : "Error interno del servidor";

  if (status >= 500) {
    console.error(error);
  }

  return res.status(status).json({ message });
}
