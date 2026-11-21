import cors from "cors";
import express from "express";
import helmet from "helmet";
import morgan from "morgan";
import { env } from "./config/env.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { notFoundHandler } from "./middleware/notFound.js";
import adminEquipmentRouter from "./routes/admin-equipment.routes.js";
import authTestRouter from "./routes/auth-test.routes.js";
import equipmentRouter from "./routes/equipment.routes.js";
import healthRouter from "./routes/health.routes.js";

const app = express();

app.disable("x-powered-by");
app.use(helmet());
app.use(
  cors({
    credentials: true,
    origin(origin, callback) {
      // Non-browser clients do not send Origin; browser clients must match CLIENT_URL.
      callback(null, !origin || origin === env.CLIENT_URL);
    },
  }),
);
app.use(morgan(env.NODE_ENV === "production" ? "combined" : "dev"));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api", healthRouter);
app.use("/api/equipment", equipmentRouter);
app.use("/api/admin/equipment", adminEquipmentRouter);
if (env.NODE_ENV !== "production") {
  app.use("/api/test", authTestRouter);
}
app.use(notFoundHandler);
app.use(errorHandler);

export default app;
