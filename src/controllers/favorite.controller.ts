import type { RequestHandler } from "express";
import type { AuthenticatedUser } from "../types/authenticated-user.js";
import { HttpError } from "../utils/http-error.js";
import { parseFavoritePagination } from "../utils/favorite-validation.js";
import * as favoriteService from "../services/favorite.service.js";

function getAuthenticatedCustomer(
  user: AuthenticatedUser | undefined,
): AuthenticatedUser {
  if (!user) {
    throw new HttpError(401, "Authentication is required.");
  }
  return user;
}

export const addFavorite: RequestHandler = async (request, response) => {
  const customer = getAuthenticatedCustomer(request.user);
  const favorite = await favoriteService.addFavorite(
    customer.id,
    request.params.equipmentId,
  );

  response.status(201).json({
    success: true,
    message: "Equipment added to favorites.",
    data: {
      equipmentId: favorite.equipmentId.toString(),
      createdAt: favorite.createdAt,
    },
  });
};

export const listMyFavorites: RequestHandler = async (request, response) => {
  const customer = getAuthenticatedCustomer(request.user);
  const pagination = parseFavoritePagination(request.query);
  const result = await favoriteService.listCustomerFavorites(
    customer.id,
    pagination,
  );

  response.status(200).json({
    success: true,
    message: "Favorites fetched successfully.",
    data: result.items,
    pagination: result.pagination,
  });
};

export const removeFavorite: RequestHandler = async (request, response) => {
  const customer = getAuthenticatedCustomer(request.user);
  const favorite = await favoriteService.removeFavorite(
    customer.id,
    request.params.equipmentId,
  );

  response.status(200).json({
    success: true,
    message: "Favorite removed successfully.",
    data: { equipmentId: favorite.equipmentId.toString() },
  });
};
