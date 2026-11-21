import type { RequestHandler } from "express";
import type { AuthenticatedUser } from "../types/authenticated-user.js";
import { HttpError } from "../utils/http-error.js";
import {
  parseCreateEquipmentInput,
  parseUpdateEquipmentInput,
} from "../utils/equipment-validation.js";
import { parseEquipmentSearchQuery } from "../utils/equipment-search-validation.js";
import * as equipmentService from "../services/equipment.service.js";

function getAuthenticatedUser(
  user: AuthenticatedUser | undefined,
): AuthenticatedUser {
  if (!user) {
    throw new HttpError(401, "Authentication is required.");
  }
  return user;
}

export const listPublicEquipment: RequestHandler = async (
  request,
  response,
) => {
  const query = parseEquipmentSearchQuery(request.query);
  const result = await equipmentService.searchPublicEquipment(query);
  response.status(200).json({
    success: true,
    message: "Equipment fetched successfully.",
    data: result.equipment,
    pagination: result.pagination,
  });
};

export const listMyEquipment: RequestHandler = async (
  request,
  response,
) => {
  const user = getAuthenticatedUser(request.user);
  const equipment = await equipmentService.listOwnerEquipment(user.id);
  response.status(200).json({ success: true, data: equipment });
};

export const getEquipmentDetails: RequestHandler = async (
  request,
  response,
) => {
  const equipment = await equipmentService.getEquipmentDetails(
    request.params.id,
    request.user,
  );
  response.status(200).json({ success: true, data: equipment });
};

export const createEquipment: RequestHandler = async (request, response) => {
  const user = getAuthenticatedUser(request.user);
  const fields = parseCreateEquipmentInput(request.body);
  const equipment = await equipmentService.createEquipment(user.id, fields);
  response.status(201).json({
    success: true,
    message: "Equipment submitted for admin review.",
    data: equipment,
  });
};

export const updateMyEquipment: RequestHandler = async (
  request,
  response,
) => {
  const user = getAuthenticatedUser(request.user);
  const fields = parseUpdateEquipmentInput(request.body);
  const equipment = await equipmentService.updateOwnerEquipment(
    request.params.id,
    user.id,
    fields,
  );
  response.status(200).json({
    success: true,
    message: "Equipment updated successfully.",
    data: equipment,
  });
};

export const deleteMyEquipment: RequestHandler = async (
  request,
  response,
) => {
  const user = getAuthenticatedUser(request.user);
  const equipment = await equipmentService.softDeleteOwnerEquipment(
    request.params.id,
    user.id,
  );
  response.status(200).json({
    success: true,
    message: "Equipment deleted successfully.",
    data: equipment,
  });
};
