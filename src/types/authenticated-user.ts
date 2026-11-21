import type { Types } from "mongoose";
import type { UserRole } from "../models/types.js";

export interface AuthenticatedUser {
  id: Types.ObjectId;
  email: string;
  role: UserRole;
  name: string;
}
