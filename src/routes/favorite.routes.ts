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

const favoriteRouter = Router();
favoriteRouter.use(verifyToken, verifyRenter);

favoriteRouter.get("/", listMyFavorites);
favoriteRouter.post("/:equipmentId", addFavorite);
favoriteRouter.delete("/:equipmentId", removeFavorite);

export default favoriteRouter;
