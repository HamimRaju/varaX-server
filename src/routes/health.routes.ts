import { Router } from "express";
import { env } from "../config/env.js";

const healthRouter = Router();

healthRouter.get("/health", (_request, response) => {
  response.status(200).json({
    success: true,
    message: "VaraX server is running",
    environment: env.NODE_ENV,
  });
});

export default healthRouter;
