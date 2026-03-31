import express from "express";
import cors from "cors";
import { authRouter } from "./routes/auth.mjs";
import { fuelGovRouter } from "./routes/fuelGov.mjs";
import { dashboardRouter } from "./routes/dashboard.mjs";
import { loadBoardRouter } from "./routes/loadBoard.mjs";
import { adminRouter } from "./routes/admin.mjs";
import { webhooksRouter } from "./routes/webhooks.mjs";
import { fuelDbRouter } from "./routes/fuelDb.mjs";
import { forecastRouter } from "./routes/forecast.mjs";

export function createApp() {
  const app = express();
  app.use(
    cors({
      origin: "*",
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowedHeaders: [
        "Content-Type",
        "Accept",
        "Authorization",
        "x-client-info",
        "apikey",
      ],
    })
  );
  app.use(express.json({ limit: "200kb" }));

  app.get("/health", (req, res) => {
    res.json({ ok: true });
  });

  app.use("/auth", authRouter);
  app.use(fuelGovRouter);
  app.use(dashboardRouter);
  app.use("/load-board", loadBoardRouter);
  app.use("/admin", adminRouter);
  app.use("/webhooks", webhooksRouter);
  app.use("/fuel-db", fuelDbRouter);
  app.use(forecastRouter);

  app.use((req, res) => {
    res.status(404).json({ error: "Not found" });
  });

  app.use((err, req, res, next) => {
    if (res.headersSent) {
      next(err);
      return;
    }
    const code = Number(err.status ?? err.statusCode);
    const status = code >= 400 && code < 600 ? code : 500;
    res.status(status).json({ error: err.message || "Server error" });
  });

  return app;
}
