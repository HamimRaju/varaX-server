import mongoose from "mongoose";
import { env } from "./env.js";

let connectionPromise: Promise<typeof mongoose> | undefined;

mongoose.connection.on("disconnected", () => {
  connectionPromise = undefined;
});

export async function connectDatabase(): Promise<typeof mongoose> {
  if (mongoose.connection.readyState === 1) {
    return mongoose;
  }

  if (connectionPromise) {
    return connectionPromise;
  }

  const pendingConnection = mongoose.connect(env.MONGODB_URI, {
    serverSelectionTimeoutMS: 10_000,
  });
  connectionPromise = pendingConnection;

  try {
    const connectedMongoose = await pendingConnection;
    console.info(
      `MongoDB connected${connectedMongoose.connection.name ? ` to ${connectedMongoose.connection.name}` : ""}.`,
    );
    return connectedMongoose;
  } catch {
    if (connectionPromise === pendingConnection) {
      connectionPromise = undefined;
    }

    console.error(
      "MongoDB connection failed. Check MONGODB_URI and confirm the database is reachable.",
    );
    throw new Error(
      "Unable to connect to MongoDB. The server was not started; verify MONGODB_URI and database availability.",
    );
  }
}
