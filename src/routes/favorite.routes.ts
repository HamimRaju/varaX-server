import { Router } from "express";
import {
  addFavorite,
  listMyFavorites,
  removeFavorite,
} from "../controllers/favorite.controller.js";
import {
  verifyRenter,
  verifyToken,
} from "../middleware/auth.middleware.js";
import { accountWriteLimiter } from "../middleware/rate-limit.middleware.js";

const favoriteRouter = Router();
favoriteRouter.use(verifyToken, verifyRenter);

favoriteRouter.get("/", listMyFavorites);
favoriteRouter.post("/:equipmentId", accountWriteLimiter, addFavorite);
favoriteRouter.delete("/:equipmentId", accountWriteLimiter, removeFavorite);

export default favoriteRouter;
