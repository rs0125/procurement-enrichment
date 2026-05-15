import { prisma } from "../../config/prisma.mjs";

export async function insertRunLog({ jobName, status, durationMs, metadata, notes }) {
  return prisma.cronRunLog.create({
    data: { jobName, status, durationMs, metadata, notes },
  });
}
