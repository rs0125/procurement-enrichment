import { env } from "../config/env.mjs";

export function requireCronAuth(req, res, next) {
  const header = req.get("Authorization") || "";
  const expected = `Bearer ${env.CRON_SECRET}`;
  if (header !== expected) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
}
