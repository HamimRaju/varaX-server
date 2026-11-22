import app from "./app.js";
import { connectDatabase } from "./config/database.js";
import { env } from "./config/env.js";

let httpServer: ReturnType<typeof app.listen> | undefined;
let databaseConnection: Awaited<ReturnType<typeof connectDatabase>> | undefined;
let shutdownStarted = false;

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shutdownStarted) return;
  shutdownStarted = true;
  console.info(`Received ${signal}; closing the server.`);

  if (httpServer) {
    await new Promise<void>((resolve) => {
      httpServer?.close(() => resolve());
    }); 
  }

  try {
    await databaseConnection?.disconnect();
    console.info("MongoDB connection closed.");
  } catch {
    console.error("MongoDB connection could not be closed cleanly.");
    process.exitCode = 1;
  }
}

async function startServer(): Promise<void> {
  try {
    databaseConnection = await connectDatabase();

    httpServer = app.listen(env.PORT, () => {
      console.info(`VaraX server is listening on port ${env.PORT}.`);
    });
    process.once("SIGINT", () => void shutdown("SIGINT"));
    process.once("SIGTERM", () => void shutdown("SIGTERM"));
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "Server startup failed.",
    );
    process.exitCode = 1;
  }
}

void startServer();
