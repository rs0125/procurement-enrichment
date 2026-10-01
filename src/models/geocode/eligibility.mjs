// Shared by the existing cron selector and the queue's read-only planner.
// Aliases w/d/a are fixed repository SQL, never caller-supplied identifiers.
export const GEOCODE_ELIGIBILITY_SQL = `w."googleLocation" IS NOT NULL AND w."googleLocation"<>''
  AND (w."createdAt">now()-interval '7 days' OR w."status_updated_at">now()-interval '7 days')
  AND (d.latitude IS NULL OR d.longitude IS NULL) AND a."succeededAt" IS NULL
  AND (a.id IS NULL OR (a."attemptCount"<5 AND a."lastAttemptAt"<now()-interval '24 hours'))`;
