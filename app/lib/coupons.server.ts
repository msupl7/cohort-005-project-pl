import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { db } from "~/db";
import {
  coupons,
  enrollments,
  purchases,
  refunds,
  RefundStatus,
} from "~/db/schema";

// Team Seats are shared as coupons. Claiming one (redeeming its coupon)
// enrolls the Student.

type Coupon = typeof coupons.$inferSelect;

/**
 * Where a Team Seat stands. A Team Refund locks a seat while Requested and
 * cancels it once Approved; declining clears `refundId` and unlocks it.
 */
export type SeatState = "unclaimed" | "claimed" | "locked" | "cancelled";

/** An Unclaimed Team Seat: nobody has claimed it and no Team Refund holds it. */
export function isUnclaimedSeat(seat: {
  redeemedAt: string | null;
  refundId: number | null;
}): boolean {
  return seat.redeemedAt === null && seat.refundId === null;
}

export function getSeatState(coupon: Coupon): SeatState {
  if (coupon.redeemedAt !== null) return "claimed";
  if (coupon.refundId === null) return "unclaimed";

  const refund = db
    .select({ status: refunds.status })
    .from(refunds)
    .where(eq(refunds.id, coupon.refundId))
    .get();
  return refund?.status === RefundStatus.Approved ? "cancelled" : "locked";
}

export const SEAT_UNAVAILABLE_MESSAGES: Record<
  Exclude<SeatState, "unclaimed">,
  string
> = {
  claimed: "Coupon has already been redeemed",
  locked: "This seat is part of a refund request and can't be claimed right now.",
  cancelled: "This seat was cancelled when the team was refunded.",
};

export function getCouponByCode(code: string) {
  return db.select().from(coupons).where(eq(coupons.code, code)).get();
}

/** Whether the Student holds a Claimed Team Seat for the course. */
export function hasClaimedTeamSeat(userId: number, courseId: number): boolean {
  const seat = db
    .select({ id: coupons.id })
    .from(coupons)
    .where(
      and(
        eq(coupons.redeemedByUserId, userId),
        eq(coupons.courseId, courseId),
        isNotNull(coupons.redeemedAt)
      )
    )
    .get();
  return seat !== undefined;
}

export type RedeemResult =
  | { ok: true; enrollment: typeof enrollments.$inferSelect }
  | { ok: false; error: string };

export function redeemCoupon(
  code: string,
  userId: number,
  userCountry: string
): RedeemResult {
  const coupon = getCouponByCode(code);
  if (!coupon) {
    return { ok: false, error: "Coupon not found" };
  }

  const state = getSeatState(coupon);
  if (state !== "unclaimed") {
    return { ok: false, error: SEAT_UNAVAILABLE_MESSAGES[state] };
  }

  const existingEnrollment = db
    .select()
    .from(enrollments)
    .where(
      and(
        eq(enrollments.userId, userId),
        eq(enrollments.courseId, coupon.courseId)
      )
    )
    .get();

  if (existingEnrollment) {
    return { ok: false, error: "You are already enrolled in this course" };
  }

  const purchase = db
    .select()
    .from(purchases)
    .where(eq(purchases.id, coupon.purchaseId))
    .get();

  if (purchase?.country && purchase.country !== userCountry) {
    return {
      ok: false,
      error:
        "This coupon can only be redeemed from the same country as the buyer",
    };
  }

  return db.transaction((tx): RedeemResult => {
    // Only claim the seat if it is still unclaimed and no Team Refund has
    // locked it since we looked.
    const claimed = tx
      .update(coupons)
      .set({ redeemedByUserId: userId, redeemedAt: new Date().toISOString() })
      .where(
        and(
          eq(coupons.id, coupon.id),
          isNull(coupons.redeemedAt),
          isNull(coupons.refundId)
        )
      )
      .run();

    if (claimed.changes === 0) {
      return { ok: false, error: SEAT_UNAVAILABLE_MESSAGES.locked };
    }

    const enrollment = tx
      .insert(enrollments)
      .values({ userId, courseId: coupon.courseId })
      .returning()
      .get();

    return { ok: true, enrollment };
  });
}
