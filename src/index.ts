import app from "./app.js";
import { connectDatabase } from "./config/database.js";
import { env } from "./config/env.js";

async function startServer(): Promise<void> {
  try {
    await connectDatabase();

    app.listen(env.PORT, () => {
      console.info(`VaraX server is listening on port ${env.PORT}.`);
    });
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "Server startup failed.",
    );
    process.exitCode = 1;
  }
}

void startServer();
