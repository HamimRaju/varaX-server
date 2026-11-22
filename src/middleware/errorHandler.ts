import type { ErrorRequestHandler } from "express";

type HttpError = Error & {
  status?: number;
  statusCode?: number;
};

export const errorHandler: ErrorRequestHandler = (
  error: unknown,
  _request,
  response,
  _next,
) => {
  const candidate =
    typeof error === "object" && error !== null
      ? (error as HttpError)
      : undefined;
  const proposedStatus = candidate?.statusCode ?? candidate?.status;
  const statusCode =
    Number.isInteger(proposedStatus) &&
    proposedStatus! >= 400 &&
    proposedStatus! <= 599
      ? proposedStatus!
      : 500;
  const errorMessage =
    error instanceof Error ? error.message : "Internal server error";
  const message =
    statusCode >= 500 && process.env.NODE_ENV === "production"
      ? "Internal server error"
      : errorMessage || "Internal server error";

  if (statusCode >= 500) {
    if (process.env.NODE_ENV === "production") {
      console.error("Request failed.", {
        name: error instanceof Error ? error.name : "UnknownError",
        code:
          typeof candidate?.cause === "object" &&
          candidate.cause !== null &&
          "code" in candidate.cause &&
          typeof candidate.cause.code === "number"
            ? candidate.cause.code
            : undefined,
      });
    } else {
      console.error(error);
    }
  }

  response.status(statusCode).json({
    success: false,
    message,
  });
};
