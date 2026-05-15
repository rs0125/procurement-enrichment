import { runGeocodeRecent } from "../../services/cron/geocodeRecent.service.mjs";

export async function geocodeRecent(_req, res, next) {
  try {
    const summary = await runGeocodeRecent();
    res.json(summary);
  } catch (err) {
    next(err);
  }
}
