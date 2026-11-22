import "dotenv/config";
import { randomBytes, scrypt as scryptCallback } from "node:crypto";
import { promisify } from "node:util";
import mongoose from "mongoose";

const scrypt = promisify(scryptCallback);
const DAY = 24 * 60 * 60 * 1000;

/**
 * Better Auth's default password hasher uses scrypt with these parameters and
 * stores `<hex salt>:<hex key>`. Keeping the same format lets these seeded demo
 * accounts sign in through the normal Better Auth email/password endpoint.
 */
async function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  const key = await scrypt(password.normalize("NFKC"), salt, 64, {
    N: 16_384,
    r: 16,
    p: 1,
    maxmem: 128 * 16_384 * 16 * 2,
  });
  return `${salt}:${key.toString("hex")}`;
}

const demoUsers = [
  {
    key: "customer",
    name: "Alex Rahman",
    email: "customer@varax.demo",
    password: "Customer123",
    role: "customer",
    phone: "01712345678",
    address: "Gulshan, Dhaka",
  },
  {
    key: "owner",
    name: "Rakib Hasan",
    email: "owner@varax.demo",
    password: "Owner123",
    role: "owner",
    phone: "01812345678",
    address: "Bashundhara, Dhaka",
  },
  {
    key: "owner2",
    name: "Nusrat Jahan",
    email: "owner2@varax.demo",
    password: "Owner123",
    role: "owner",
    phone: "01912345678",
    address: "Uttara, Dhaka",
  },
  {
    key: "admin",
    name: "VaraX Admin",
    email: "admin@varax.demo",
    password: "Admin123",
    role: "admin",
    phone: "01612345678",
    address: "Motijheel, Dhaka",
  },
];

const equipmentSeed = [
  {
    name: "CAT Excavator 320D",
    description:
      "Powerful and reliable excavator for construction and heavy-duty work. Well maintained and ready for your next project in Dhaka.",
    category: "Construction Equipment",
    location: "Bashundhara, Dhaka",
    price: 5000,
    rentalType: "daily",
    availableQuantity: 5,
    condition: "Excellent",
    brand: "CAT",
    model: "320D",
    image: "/varax-home-hero.png",
    terms: "Operator included. Fuel and site access are the renter's responsibility.",
    owner: "owner",
  },
  {
    name: "Canon EOS R6",
    description:
      "Full-frame mirrorless camera with excellent low-light performance. Includes battery, charger, and strap.",
    category: "Photography Equipment",
    location: "Banani, Dhaka",
    price: 2000,
    rentalType: "daily",
    availableQuantity: 3,
    condition: "Excellent",
    brand: "Canon",
    model: "EOS R6",
    image: "/equipment/camera.jpg",
    terms: "Return with all included accessories. A security deposit may apply.",
    owner: "owner2",
  },
  {
    name: "Toyota Hiace",
    description:
      "Spacious passenger van for family trips, airport transfers, and group travel around Bangladesh.",
    category: "Vehicles & Transportation",
    location: "Gulshan, Dhaka",
    price: 3500,
    rentalType: "daily",
    availableQuantity: 2,
    condition: "Well maintained",
    brand: "Toyota",
    model: "Hiace",
    image: "/category-thumbnails/vehicles.png",
    terms: "Driver included. Fuel is charged separately.",
    owner: "owner",
  },
  {
    name: "Mahindra Tractor",
    description:
      "Reliable farm tractor for ploughing, hauling, and seasonal agricultural work.",
    category: "Agriculture Equipment",
    location: "Sreepur, Gazipur",
    price: 2500,
    rentalType: "daily",
    availableQuantity: 3,
    condition: "Well maintained",
    brand: "Mahindra",
    model: "475 DI",
    image: "/category-thumbnails/agriculture.png",
    terms: "Fuel and operator are the renter's responsibility.",
    owner: "owner2",
  },
  {
    name: "MacBook Pro M2",
    description:
      "Fast laptop for design, development, presentations, and short-term work trips.",
    category: "Electronics",
    location: "Dhanmondi, Dhaka",
    price: 3000,
    rentalType: "weekly",
    availableQuantity: 3,
    condition: "Excellent",
    brand: "Apple",
    model: "MacBook Pro M2",
    image: "/equipment/laptop.jpg",
    terms: "Return with charger and original packaging. A security deposit may apply.",
    owner: "owner",
  },
  {
    name: "Moving Head Light",
    description:
      "Professional moving head lights for weddings, concerts, and stage productions.",
    category: "Event Equipment",
    location: "Uttara, Dhaka",
    price: 1500,
    rentalType: "daily",
    availableQuantity: 8,
    condition: "Excellent",
    brand: "Beamz",
    model: "Moving Head 230",
    image: "/category-thumbnails/event.png",
    terms: "Delivery and setup can be arranged for an additional fee.",
    owner: "owner2",
  },
  {
    name: "Kubota Rice Transplanter",
    description:
      "Compact rice transplanter for efficient seasonal planting on small and medium farms.",
    category: "Agriculture Equipment",
    location: "Mymensingh Sadar",
    price: 1800,
    rentalType: "daily",
    availableQuantity: 2,
    condition: "Well maintained",
    brand: "Kubota",
    model: "SPV-6CMD",
    image: "/category-thumbnails/agriculture.png",
    terms: "Operator assistance is available on request.",
    owner: "owner",
  },
  {
    name: "Canon 24–70mm Lens Kit",
    description:
      "Versatile zoom lens for portraits, events, and documentary photography.",
    category: "Photography Equipment",
    location: "Mohammadpur, Dhaka",
    price: 1200,
    rentalType: "daily",
    availableQuantity: 4,
    condition: "Excellent",
    brand: "Canon",
    model: "RF 24-70mm F2.8",
    image: "/equipment/camera.jpg",
    terms: "Return with both lens caps and the protective case.",
    owner: "owner2",
  },
  {
    name: "Toyota Noah 2020",
    description:
      "Comfortable seven-seat family vehicle for city trips and intercity travel.",
    category: "Vehicles & Transportation",
    location: "Mirpur, Dhaka",
    price: 4500,
    rentalType: "daily",
    availableQuantity: 0,
    condition: "Excellent",
    brand: "Toyota",
    model: "Noah 2020",
    image: "/category-thumbnails/vehicles.png",
    terms: "Driver included. Fuel is charged separately.",
    owner: "owner",
  },
  {
    name: "Yamaha Stage Mixer",
    description:
      "Digital mixing console for live music, conferences, and community events.",
    category: "Event Equipment",
    location: "Chattogram",
    price: 2200,
    rentalType: "daily",
    availableQuantity: 2,
    condition: "Well maintained",
    brand: "Yamaha",
    model: "MG16XU",
    image: "/category-thumbnails/event.png",
    terms: "A technician can be arranged for an additional fee.",
    owner: "owner2",
  },
  {
    name: "Dell Precision 5570",
    description:
      "Workstation laptop for CAD, video editing, and other demanding projects.",
    category: "Electronics",
    location: "Bashundhara, Dhaka",
    price: 2600,
    rentalType: "weekly",
    availableQuantity: 3,
    condition: "Excellent",
    brand: "Dell",
    model: "Precision 5570",
    image: "/equipment/laptop.jpg",
    terms: "Return with the charger and original case.",
    owner: "owner",
  },
  {
    name: "JCB Backhoe Loader",
    description:
      "Versatile backhoe loader for digging, trenching, and construction site preparation.",
    category: "Construction Equipment",
    location: "Savar, Dhaka",
    price: 6500,
    rentalType: "daily",
    availableQuantity: 2,
    condition: "Well maintained",
    brand: "JCB",
    model: "3CX",
    image: "/varax-home-hero.png",
    terms: "Operator included. Fuel and site access are the renter's responsibility.",
    owner: "owner2",
  },
  {
    name: "DJI Ronin Camera Kit",
    description:
      "Camera stabilizer kit for smooth video production and event coverage.",
    category: "Photography Equipment",
    location: "Khilgaon, Dhaka",
    price: 2800,
    rentalType: "daily",
    availableQuantity: 2,
    condition: "Excellent",
    brand: "DJI",
    model: "Ronin-S",
    image: "/equipment/camera.jpg",
    terms: "Return with all batteries, cables, and the carrying case.",
    owner: "owner",
  },
  {
    name: "Power Tiller",
    description:
      "Two-wheel tractor for soil preparation and small-farm work.",
    category: "Agriculture Equipment",
    location: "Narayanganj",
    price: 1400,
    rentalType: "daily",
    availableQuantity: 4,
    condition: "Well maintained",
    brand: "Kubota",
    model: "Power Tiller",
    image: "/category-thumbnails/agriculture.png",
    terms: "Fuel is the renter's responsibility.",
    owner: "owner2",
  },
  {
    name: "LED Projector & Screen",
    description:
      "Bright projector and portable screen for meetings, classes, and events.",
    category: "Electronics",
    location: "Motijheel, Dhaka",
    price: 1800,
    rentalType: "daily",
    availableQuantity: 3,
    condition: "Excellent",
    brand: "Epson",
    model: "EB-FH52",
    image: "/equipment/laptop.jpg",
    terms: "Return with all cables and the remote control.",
    owner: "owner",
  },
  {
    name: "Pickup Truck",
    description:
      "Utility pickup for local transport, deliveries, and equipment movement.",
    category: "Vehicles & Transportation",
    location: "Tejgaon, Dhaka",
    price: 2800,
    rentalType: "daily",
    availableQuantity: 3,
    condition: "Well maintained",
    brand: "Toyota",
    model: "Hilux",
    image: "/category-thumbnails/vehicles.png",
    terms: "Driver included. Fuel is charged separately.",
    owner: "owner2",
  },
  {
    name: "Truss & Stage Light Set",
    description:
      "Complete truss and stage lighting set for events, weddings, and productions.",
    category: "Event Equipment",
    location: "Uttara, Dhaka",
    price: 3200,
    rentalType: "daily",
    availableQuantity: 0,
    condition: "Excellent",
    brand: "Generic",
    model: "Stage Kit",
    image: "/category-thumbnails/event.png",
    terms: "Setup and teardown can be arranged for an additional fee.",
    owner: "owner",
  },
  {
    name: "Mini Excavator",
    description:
      "Compact excavator for landscaping, small construction jobs, and tight workspaces.",
    category: "Construction Equipment",
    location: "Keraniganj, Dhaka",
    price: 4200,
    rentalType: "daily",
    availableQuantity: 3,
    condition: "Well maintained",
    brand: "Kubota",
    model: "U-17",
    image: "/varax-home-hero.png",
    terms: "Operator included. Fuel is the renter's responsibility.",
    owner: "owner2",
  },
  {
    name: "Bosch Rotary Hammer",
    description:
      "Heavy-duty rotary hammer for concrete drilling and demolition work.",
    category: "Construction Equipment",
    location: "Mirpur, Dhaka",
    price: 900,
    rentalType: "daily",
    availableQuantity: 2,
    condition: "Good",
    brand: "Bosch",
    model: "GBH 2-26",
    image: "/category-thumbnails/construction.png",
    terms: "Return with the carry case and drill bits.",
    owner: "owner",
    status: "pending",
  },
];

async function main() {
  const uri = process.env.MONGODB_URI?.trim();
  if (!uri) {
    throw new Error("MONGODB_URI is required to seed demo data.");
  }

  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10_000 });
  const db = mongoose.connection.db;
  if (!db) throw new Error("MongoDB connection did not expose a database.");

  const users = db.collection("users");
  const accounts = db.collection("account");
  const equipment = db.collection("equipment");
  const now = new Date();

  const seededUsers = new Map();

  for (const definition of demoUsers) {
    const existing = await users.findOne({ email: definition.email });
    let userId;

    if (existing) {
      userId = existing._id;
      await users.updateOne(
        { _id: userId },
        {
          $set: {
            name: definition.name,
            role: definition.role,
            phone: definition.phone,
            address: definition.address,
            isActive: true,
            emailVerified: true,
            updatedAt: now,
          },
        },
      );
    } else {
      const inserted = await users.insertOne({
        name: definition.name,
        email: definition.email,
        emailVerified: true,
        image: null,
        role: definition.role,
        phone: definition.phone,
        address: definition.address,
        isActive: true,
        createdAt: now,
        updatedAt: now,
      });
      userId = inserted.insertedId;
    }

    const passwordHash = await hashPassword(definition.password);
    const account = await accounts.findOne({
      userId,
      providerId: "credential",
    });
    if (account) {
      await accounts.updateOne(
        { _id: account._id },
        {
          $set: {
            accountId: userId.toString(),
            password: passwordHash,
            updatedAt: now,
          },
        },
      );
    } else {
      await accounts.insertOne({
        userId,
        accountId: userId.toString(),
        providerId: "credential",
        password: passwordHash,
        createdAt: now,
        updatedAt: now,
      });
    }

    seededUsers.set(definition.key, userId);
    console.log(`Seeded ${definition.role}: ${definition.email}`);
  }

  let index = 0;
  for (const item of equipmentSeed) {
    const ownerId = seededUsers.get(item.owner);
    if (!ownerId) throw new Error(`Missing seed owner: ${item.owner}`);
    const createdAt = new Date(now.getTime() - index * 3 * DAY);
    const { owner: _owner, status = "approved", ...fields } = item;

    await equipment.updateOne(
      { name: item.name, ownerId },
      {
        $set: {
          ...fields,
          ownerId,
          status,
          isDeleted: false,
          reservationVersion: 0,
          updatedAt: now,
        },
        $setOnInsert: { createdAt },
      },
      { upsert: true },
    );
    index += 1;
  }

  console.log(`Seeded ${equipmentSeed.length} equipment listings.`);
  console.log("\nDemo accounts:");
  for (const definition of demoUsers) {
    console.log(`  ${definition.role.padEnd(8)} ${definition.email} / ${definition.password}`);
  }

  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error(error);
  await mongoose.disconnect().catch(() => {});
  process.exitCode = 1;
});
