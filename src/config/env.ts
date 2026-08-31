import dotenv from "dotenv";
dotenv.config();

function required(name: string): string {
  const val = process.env[name];
  if (!val) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return val;
}

export const env = {
  port: parseInt(process.env.PORT || "4000", 10),
  nodeEnv: process.env.NODE_ENV || "development",
  corsOrigins: (process.env.CORS_ORIGIN || "http://localhost:5173")
    .split(",")
    .map((s) => s.trim()),

  jwtSecret: required("JWT_SECRET"),
  // Only read once, by adminService.ensureBootstrapAdmin() at startup, to
  // seed the first row of the `admins` table if it's still empty. Login
  // itself checks that table (bcrypt-hashed passwords), not these — see
  // routes/auth.ts. Safe to leave set after that; it's a no-op once any
  // admin exists.
  adminUsername: required("ADMIN_USERNAME"),
  adminPassword: required("ADMIN_PASSWORD"),

  databaseUrl: required("DATABASE_URL"),
  databaseSsl: process.env.DATABASE_SSL === "true",

  routeros: {
    host: required("ROUTEROS_HOST"),
    port: parseInt(process.env.ROUTEROS_PORT || "8728", 10),
    user: required("ROUTEROS_USER"),
    password: required("ROUTEROS_PASSWORD"),
    tls: process.env.ROUTEROS_TLS === "true",
  },

  webhookSharedSecret: required("WEBHOOK_SHARED_SECRET"),

  // Optional, unlike the vars above: the app must keep working for
  // deployments that haven't set up online payments yet. paymentService
  // checks these at call time and fails clearly if a route needs them and
  // they're empty, rather than crashing the whole process at boot.
  paystack: {
    secretKey: process.env.PAYSTACK_SECRET_KEY || "",
    publicKey: process.env.PAYSTACK_PUBLIC_KEY || "",
  },
};
