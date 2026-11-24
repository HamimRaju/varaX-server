import "dotenv/config";
import { z } from "zod";

const environmentSchema = z
  .object({
    PORT: z.coerce.number().int().min(1).max(65_535).default(5001),
    TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(0),
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    MONGODB_URI: z
      .string()
      .trim()
      .min(1, "MONGODB_URI must be configured before the server can start."),
    MONGODB_DB_NAME: z.string().trim().min(1).default("varax"),
    STRIPE_SECRET_KEY: z
      .string()
      .trim()
      .regex(/^sk_(test|live)_/, "STRIPE_SECRET_KEY must be a Stripe secret key."),
    STRIPE_WEBHOOK_SECRET: z
      .string()
      .trim()
      .regex(/^whsec_/, "STRIPE_WEBHOOK_SECRET must be a Stripe webhook secret."),
    CLIENT_URL: z.string().trim().default(""),
    JWT_ISSUER: z.string().trim().url(),
    JWT_AUDIENCE: z.string().trim().min(1),
    JWKS_URL: z.string().trim().url(),
  })
  .superRefine((values, context) => {
    if (values.CLIENT_URL && !URL.canParse(values.CLIENT_URL)) {
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

    if (values.NODE_ENV === "production") {
      if (
        values.CLIENT_URL &&
        new URL(values.CLIENT_URL).protocol !== "https:"
      ) {
        context.addIssue({
          code: "custom",
          path: ["CLIENT_URL"],
          message: "CLIENT_URL must use HTTPS in production.",
        });
      }
      for (const [key, value] of [
        ["JWT_ISSUER", values.JWT_ISSUER],
        ["JWKS_URL", values.JWKS_URL],
      ] as const) {
        if (new URL(value).protocol !== "https:") {
          context.addIssue({
            code: "custom",
            path: [key],
            message: `${key} must use HTTPS in production.`,
          });
        }
      }
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
