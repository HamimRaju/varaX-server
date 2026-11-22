import type { RequestHandler, Response } from "express";
import { jwtVerify } from "jose";
import { Types } from "mongoose";
import { jwtVerificationConfig, remoteJwks } from "../config/jwt.js";
import { User } from "../models/User.js";
import { USER_ROLES, type UserRole } from "../models/types.js";
import { protectedRequestLimiter } from "./rate-limit.middleware.js";

const unauthorized = (
  response: Response,
  message = "A valid bearer token is required.",
): void => {
  response.status(401).json({ success: false, message });
};

const forbidden = (response: Response): void => {
  response.status(403).json({
    success: false,
    message: "You do not have permission to access this resource.",
  });
};

function isUserRole(role: unknown): role is UserRole {
  return (
    typeof role === "string" &&
    USER_ROLES.some((supportedRole) => supportedRole === role)
  );
}

const verifyTokenFromDatabase: RequestHandler = async (
  request,
  response,
  next,
) => {
  const authorization = request.get("authorization");
  if (!authorization) {
    unauthorized(response);
    return;
  }

  const bearerMatch = /^Bearer\s+([^\s]+)$/i.exec(authorization.trim());
  const token = bearerMatch?.[1];
  if (!token) {
    unauthorized(response);
    return;
  }

  let subject: string | undefined;

  try {
    const { payload } = await jwtVerify(token, remoteJwks, {
      issuer: jwtVerificationConfig.issuer,
      audience: jwtVerificationConfig.audience,
      algorithms: ["EdDSA"],
      requiredClaims: ["exp", "sub", "iss", "aud"],
    });
    subject = payload.sub;
  } catch {
    unauthorized(response, "Invalid or expired access token.");
    return;
  }

  if (!subject || !/^[a-f\d]{24}$/i.test(subject)) {
    unauthorized(response, "Invalid access token identity.");
    return;
  }

  let databaseUser: Awaited<ReturnType<typeof findUserById>>;
  try {
    databaseUser = await findUserById(subject);
  } catch (error) {
    next(error);
    return;
  }

  if (!databaseUser) {
    unauthorized(response, "The account associated with this token was not found.");
    return;
  }

  if (databaseUser.isActive !== true) {
    forbidden(response);
    return;
  }

  if (
    !isUserRole(databaseUser.role) ||
    typeof databaseUser.name !== "string" ||
    typeof databaseUser.email !== "string"
  ) {
    forbidden(response);
    return;
  }

  request.user = {
    id: databaseUser._id,
    email: databaseUser.email,
    role: databaseUser.role,
    name: databaseUser.name,
  };

  next();
};

export const verifyToken: RequestHandler = (request, response, next) => {
  protectedRequestLimiter(request, response, (error?: unknown) => {
    if (error) {
      next(error);
      return;
    }
    if (response.headersSent) return;
    void verifyTokenFromDatabase(request, response, next);
  });
};

async function findUserById(subject: string) {
  return User.findById(new Types.ObjectId(subject))
    .select("_id email name role isActive")
    .lean()
    .exec();
}

function requireRole(requiredRole: UserRole): RequestHandler {
  return (request, response, next) => {
    if (!request.user) {
      unauthorized(response);
      return;
    }

    if (request.user.role !== requiredRole) {
      forbidden(response);
      return;
    }

    next();
  };
}

export const verifyRenter = requireRole("customer");
export const verifyOwner = requireRole("owner");
export const verifyAdmin = requireRole("admin");
