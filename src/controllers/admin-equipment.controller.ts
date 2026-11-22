import type { RequestHandler } from "express";
import { HttpError } from "../utils/http-error.js";
import {
  parseAdminUpdateEquipmentInput,
  parseEquipmentStatus,
} from "../utils/equipment-validation.js";
import { parseAdminEquipmentQuery } from "../utils/admin-validation.js";
import * as equipmentService from "../services/equipment.service.js";

export const listAllEquipment: RequestHandler = async (
  request,
  response,
) => {
  const query = parseAdminEquipmentQuery(
    request.query as Record<string, unknown>,
  );
  const result = await equipmentService.listAllEquipment(query);
  response.status(200).json({
    success: true,
    message: "Admin equipment fetched successfully.",
    data: result.equipment,
    pagination: result.pagination,
  });
};

export const updateEquipmentStatus: RequestHandler = async (
  request,
  response,
) => {
  const status = parseEquipmentStatus(request.body);
  const equipment = await equipmentService.setEquipmentStatus(
    request.params.id,
    status,
  );
  response.status(200).json({
    success: true,
    message: `Equipment status changed to ${status}.`,
    data: equipment,
  });
};

export const updateEquipmentAsAdmin: RequestHandler = async (
  request,
  response,
) => {
  const fields = parseAdminUpdateEquipmentInput(request.body);
  const equipment = await equipmentService.updateAdminEquipment(
    request.params.id,
    fields,
  );
  response.status(200).json({
    success: true,
    message: "Equipment updated successfully.",
    data: equipment,
  });
};

export const deleteEquipmentAsAdmin: RequestHandler = async (
  request,
  response,
) => {
  const equipment = await equipmentService.softDeleteAdminEquipment(
    request.params.id,
  );
  response.status(200).json({
    success: true,
    message: "Equipment deleted successfully.",
    data: equipment,
  });
};
