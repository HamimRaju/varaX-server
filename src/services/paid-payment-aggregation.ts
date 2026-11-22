import { Types, type PipelineStage } from "mongoose";

export interface PaidPaymentAggregationOptions {
  ownerId?: Types.ObjectId;
  startDate?: Date;
  endDateExclusive?: Date;
}

/**
 * Produces one row per successful Stripe PaymentIntent (or Payment record when
 * no intent ID is available), linked through the authoritative Booking record.
 * Refund and reconciliation states are deliberately excluded from earnings.
 */
export function successfulPaymentStages(
  options: PaidPaymentAggregationOptions = {},
): PipelineStage[] {
  const dateRange =
    options.startDate || options.endDateExclusive
      ? {
          ...(options.startDate ? { $gte: options.startDate } : {}),
          ...(options.endDateExclusive
            ? { $lt: options.endDateExclusive }
            : {}),
        }
      : undefined;

  return [
    { $match: options.ownerId ? { ownerId: options.ownerId } : {} },
    {
      $lookup: {
        from: "payments",
        localField: "_id",
        foreignField: "bookingId",
        pipeline: [
          {
            $match: {
              paymentStatus: "paid",
              fulfillmentStatus: {
                $nin: [
                  "refunded",
                  "refund_pending",
                  "refund_required",
                  "review_required",
                ],
              },
            },
          },
        ],
        as: "payments",
      },
    },
    { $unwind: "$payments" },
    {
      $addFields: {
        earningDate: {
          $ifNull: ["$payments.paidAt", "$payments.createdAt"],
        },
        grossAmount: {
          $ifNull: [
            { $divide: ["$payments.receivedAmountMinorUnits", 100] },
            {
              $ifNull: [
                { $divide: ["$payments.amountMinorUnits", 100] },
                "$payments.amount",
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
        grossAmount: { $type: "number", $gt: 0 },
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
        currency: { $first: "$earningCurrency" },
        amount: { $max: "$grossAmount" },
      },
    },
  ];
}
