import cors from "cors";
import express from "express";
import helmet from "helmet";
import morgan from "morgan";
import { env } from "./config/env.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { notFoundHandler } from "./middleware/notFound.js";
import adminEquipmentRouter from "./routes/admin-equipment.routes.js";
import adminManagementRouter from "./routes/admin-management.routes.js";
import authTestRouter from "./routes/auth-test.routes.js";
import bookingRouter from "./routes/booking.routes.js";
import customerDashboardRouter from "./routes/customer-dashboard.routes.js";
import equipmentRouter from "./routes/equipment.routes.js";
import favoriteRouter from "./routes/favorite.routes.js";
import healthRouter from "./routes/health.routes.js";
import ownerDashboardRouter from "./routes/owner-dashboard.routes.js";
import paymentRouter from "./routes/payment.routes.js";
import paymentWebhookRouter from "./routes/payment-webhook.routes.js";

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
// Stripe signature verification requires the untouched raw request body.
app.use("/api/payments/webhook", paymentWebhookRouter);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api", healthRouter);
app.use("/api/bookings", bookingRouter);
app.use("/api/customer/dashboard", customerDashboardRouter);
app.use("/api/owner/dashboard", ownerDashboardRouter);
app.use("/api/equipment", equipmentRouter);
app.use("/api/admin/equipment", adminEquipmentRouter);
app.use("/api/admin", adminManagementRouter);
app.use("/api/favorites", favoriteRouter);
app.use("/api/payments", paymentRouter);
if (env.NODE_ENV !== "production") {
  app.use("/api/test", authTestRouter);
}
app.use(notFoundHandler);
app.use(errorHandler);

export default app;
