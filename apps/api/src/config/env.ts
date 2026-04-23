import "dotenv/config";

const isProduction = process.env.NODE_ENV === "production";
const jwtSecret = process.env.JWT_SECRET;

function parsePositiveInteger(value: string | undefined, fallback: number, variableName: string) {
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${variableName} debe ser un entero positivo`);
  }

  return parsed;
}

const port = parsePositiveInteger(process.env.PORT, 4000, "PORT");
const accessTokenTtlMinutes = parsePositiveInteger(
  process.env.ACCESS_TOKEN_TTL_MINUTES,
  15,
  "ACCESS_TOKEN_TTL_MINUTES"
);
const refreshTokenTtlDays = parsePositiveInteger(
  process.env.REFRESH_TOKEN_TTL_DAYS,
  30,
  "REFRESH_TOKEN_TTL_DAYS"
);

const refreshTokenCookieName = process.env.REFRESH_TOKEN_COOKIE_NAME?.trim() || "live_chat_rt";

const refreshTokenCookieSameSiteRaw = (process.env.REFRESH_TOKEN_COOKIE_SAME_SITE ?? "lax")
  .trim()
  .toLowerCase();

const allowedSameSiteValues = new Set(["lax", "strict", "none"]);

if (!allowedSameSiteValues.has(refreshTokenCookieSameSiteRaw)) {
  throw new Error("REFRESH_TOKEN_COOKIE_SAME_SITE debe ser lax, strict o none");
}

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
  isProduction,
  jwtSecret: resolvedJwtSecret,
  port,
  webOrigin: process.env.WEB_ORIGIN ?? "http://localhost:5173",
  accessTokenTtlMinutes,
  refreshTokenTtlDays,
  refreshTokenCookieName,
  refreshTokenCookieSameSite: refreshTokenCookieSameSiteRaw as "lax" | "strict" | "none"
};
