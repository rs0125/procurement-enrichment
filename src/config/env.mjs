import "dotenv/config";

function required(name) {
  const v = process.env[name];
  if (!v || v.trim() === "") {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v;
}

export const env = {
  DATABASE_URL: required("DATABASE_URL"),
  CRON_SECRET: required("CRON_SECRET"),
  PORT: Number(process.env.PORT) || 3000,
};
