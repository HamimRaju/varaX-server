import express from "express";

// Load the API only when a request arrives so configuration or database
// startup errors can be returned as a useful service-unavailable response
// instead of causing Vercel's generic FUNCTION_INVOCATION_FAILED page.
const vercelApp = express();
type ApiHandler = typeof import("./express-app.js").default;
let apiHandlerPromise: Promise<ApiHandler> | undefined;

function getApiHandler(): Promise<ApiHandler> {
  if (!apiHandlerPromise) {
    apiHandlerPromise = (async () => {
      const [{ connectDatabase }, { default: app }] = await Promise.all([
        import("./config/database.js"),
        import("./express-app.js"),
      ]);

      await connectDatabase();
      return app;
    })().catch((error: unknown) => {
      apiHandlerPromise = undefined;
      throw error;
    });
  }

  return apiHandlerPromise;
}

function getSafeStartupReason(error: unknown): string {
  if (!(error instanceof Error)) return "Unknown initialization error";
  if (error.message.includes("Unable to connect to MongoDB")) {
    return "MongoDB connection failed";
  }

  const invalidSettings = [
    ...error.message.matchAll(/(?:^|\n)([A-Z][A-Z0-9_]*):/g),
  ].map((match) => match[1]);

  if (invalidSettings.length) {
    return `Invalid server environment variables: ${[...new Set(invalidSettings)].join(", ")}`;
  }

  return error.name || "Initialization error";
}

vercelApp.use(async (request, response, next) => {
  try {
    const app = await getApiHandler();
    app(request, response, next);
  } catch (error) {
    console.error("VaraX API initialization failed.", {
      reason: getSafeStartupReason(error),
    });
    response.status(503).json({
      success: false,
      message:
        "The API is temporarily unavailable. Check the server deployment environment and MongoDB connection.",
    });
  }
});

export default vercelApp;
