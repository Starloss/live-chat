import "dotenv/config";

const isProduction = process.env.NODE_ENV === "production";
const jwtSecret = process.env.JWT_SECRET;

const resolvedJwtSecret =
  jwtSecret ?? (isProduction ? undefined : "dev-insecure-jwt-secret");

if (!resolvedJwtSecret) {
  throw new Error("Falta JWT_SECRET en variables de entorno");
}

if (!jwtSecret && !isProduction) {
  console.warn(
    "JWT_SECRET no definido: usando valor temporal de desarrollo. Configura apps/api/.env para evitar esto."
  );
}

export const env = {
  jwtSecret: resolvedJwtSecret,
  port: Number(process.env.PORT ?? 4000),
  webOrigin: process.env.WEB_ORIGIN ?? "http://localhost:5173"
};
