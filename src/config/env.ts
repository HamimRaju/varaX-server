import "dotenv/config";
import { z } from "zod";

const environmentSchema = z
  .object({
    PORT: z.coerce.number().int().min(1).max(65_535).default(5000),
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    MONGODB_URI: z
      .string()
      .trim()
      .min(1, "MONGODB_URI must be configured before the server can start."),
    CLIENT_URL: z.string().trim().default(""),
    JWT_SECRET: z.string().default(""),
  })
  .superRefine((values, context) => {
    if (
      values.CLIENT_URL &&
      !URL.canParse(values.CLIENT_URL)
    ) {
      context.addIssue({
        code: "custom",
        path: ["CLIENT_URL"],
        message: "CLIENT_URL must be a valid URL.",
      });
    }

    if (values.NODE_ENV === "production" && !values.CLIENT_URL) {
      context.addIssue({
        code: "custom",
        path: ["CLIENT_URL"],
        message: "CLIENT_URL is required in production.",
      });
    }
  });

const result = environmentSchema.safeParse(process.env);

if (!result.success) {
  const details = result.error.issues
    .map((issue) => `${issue.path.join(".") || "environment"}: ${issue.message}`)
    .join("\n");

  throw new Error(`Invalid environment configuration:\n${details}`);
}

export const env = result.data;
