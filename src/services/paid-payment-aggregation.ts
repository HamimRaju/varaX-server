import { Types, type PipelineStage } from "mongoose";

export interface PaidPaymentAggregationOptions {
  ownerId?: Types.ObjectId;
  startDate?: Date;
  endDateExclusive?: Date;
  timestampBasis?: "paidAt" | "paidAtOrCreatedAt";
}

/**
 * Produces one row per successful Stripe PaymentIntent (or Payment record when
 * no intent ID is available), linked through the authoritative Booking record.
 * Refund and reconciliation states are deliberately excluded from earnings.
 */
export function successfulPaymentStages(
  options: PaidPaymentAggregationOptions = {},
): PipelineStage.FacetPipelineStage[] {
  const dateRange =
    options.startDate || options.endDateExclusive
      ? {
          ...(options.startDate ? { $gte: options.startDate } : {}),
          ...(options.endDateExclusive
            ? { $lt: options.endDateExclusive }
            : {}),
        }
      : undefined;
  const paymentMatch: Record<string, unknown> = {
    paymentStatus: "paid",
    fulfillmentStatus: {
      $nin: [
        "refunded",
        "refund_pending",
        "refund_required",
        "review_required",
      ],
    },
  };
  if (dateRange) {
    paymentMatch.$or =
      options.timestampBasis === "paidAt"
        ? [{ paidAt: dateRange }]
        : [
            { paidAt: dateRange },
            { paidAt: { $in: [null] }, createdAt: dateRange },
          ];
  }

  return [
    { $match: options.ownerId ? { ownerId: options.ownerId } : {} },
    {
      $lookup: {
        from: "payments",
        localField: "_id",
        foreignField: "bookingId",
        pipeline: [
          { $match: paymentMatch },
        ],
        as: "payments",
      },
    },
    { $unwind: "$payments" },
    {
      $addFields: {
        earningDate:
          options.timestampBasis === "paidAt"
            ? "$payments.paidAt"
            : { $ifNull: ["$payments.paidAt", "$payments.createdAt"] },
        grossAmountMinorUnits: {
          $ifNull: [
            "$payments.receivedAmountMinorUnits",
            {
              $ifNull: [
                "$payments.amountMinorUnits",
                {
                  $round: [
                    { $multiply: ["$payments.amount", 100] },
                    0,
                  ],
                },
              ],
            },
          ],
        },
        earningCurrency: {
          $ifNull: [
            "$payments.receivedCurrency",
            { $ifNull: ["$payments.currency", "bdt"] },
          ],
        },
        paymentIntentKey: {
          $ifNull: ["$payments.stripePaymentIntentId", "$payments._id"],
        },
      },
    },
    {
      $match: {
        earningDate: {
          $type: "date",
          ...(dateRange ?? {}),
        },
        grossAmountMinorUnits: { $type: "number", $gt: 0 },
      },
    },
    { $sort: { earningDate: -1, "payments._id": -1 } },
    {
      $group: {
        _id: "$paymentIntentKey",
        paymentId: { $first: "$payments._id" },
        bookingId: { $first: "$_id" },
        ownerId: { $first: "$ownerId" },
        equipmentId: { $first: "$equipmentId" },
        customerId: { $first: "$customerId" },
        paidAt: { $first: "$earningDate" },
        actualPaidAt: { $first: "$payments.paidAt" },
        currency: { $first: "$earningCurrency" },
        amountMinorUnits: { $max: "$grossAmountMinorUnits" },
      },
    },
    {
      $addFields: {
        amount: { $divide: ["$amountMinorUnits", 100] },
      },
    },
  ];
}
