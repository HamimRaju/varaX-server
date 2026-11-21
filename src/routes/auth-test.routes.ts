import { Router, type RequestHandler } from "express";
import {
  verifyAdmin,
  verifyOwner,
  verifyRenter,
  verifyToken,
} from "../middleware/auth.middleware.js";

const authTestRouter = Router();

const authenticatedTestResponse: RequestHandler = (request, response) => {
  if (!request.user) {
    response.status(401).json({
      success: false,
      message: "A valid bearer token is required.",
    });
    return;
  }

  response.status(200).json({
    success: true,
    user: {
      id: request.user.id.toString(),
      name: request.user.name,
      email: request.user.email,
      role: request.user.role,
    },
  });
};

// Temporary authorization smoke-test routes; mounted only outside production.
authTestRouter.get(
  "/customer",
  verifyToken,
  verifyRenter,
  authenticatedTestResponse,
);
authTestRouter.get("/owner", verifyToken, verifyOwner, authenticatedTestResponse);
authTestRouter.get("/admin", verifyToken, verifyAdmin, authenticatedTestResponse);

export default authTestRouter;
