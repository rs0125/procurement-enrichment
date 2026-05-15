import express from "express";
import routes from "./routes/index.mjs";
import { errorHandler } from "./middlewares/errorHandler.mjs";

export function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(routes);
  app.use(errorHandler);
  return app;
}
