import express from "express";
import app from "./app.js";
import { connectDatabase } from "./config/database.js";

// Vercel imports this default export as the Express HTTP handler. MongoDB
// connections are reused across warm function invocations.
const vercelApp = express();

vercelApp.use(async (_request, response, next) => {
  try {
    await connectDatabase();
    next();
  } catch {
    response.status(503).json({
      success: false,
      message: "The database is temporarily unavailable.",
    });
  }
});
vercelApp.use(app);

export default vercelApp;
