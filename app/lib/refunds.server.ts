import { data } from "react-router";
import { and, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { db } from "~/db";
import {
  coupons,
  courses,
  enrollments,
  lessonProgress,
  lessons,
  modules,
  purchases,
  refunds,
  users,
  videoWatchEvents,
  LessonProgressStatus,
  RefundStatus,
  UserRole,
} from "~/db/schema";
import { hasClaimedTeamSeat, isUnclaimedSeat } from "~/lib/coupons.server";
import {
  MAX_COMPLETED_LESSON_SHARE,
  MAX_WATCHED_TIME_SECONDS,
  REFUND_INELIGIBLE_RESPONSES,
  REFUND_RESOLUTION_FAILURE_RESPONSES,
  buildRefundApprovedEmail,
  buildRefundDeclinedEmail,
  buildRefundRequestedEmail,
  isWithinRefundWindow,
  seatPrice,
  teamRefundAmount,
  type RefundIneligibleReason,
  type RefundResolutionFailure,
  type TeamSeats,
} from "~/lib/refunds";

type Purchase = typeof purchases.$inferSelect;

export type RefundEligibility =
  | {
      eligible: true;
      purchase: Purchase;
      refundAmount: number;
      teamSeats: TeamSeats | null;
    }
  | { eligible: false; reason: RefundIneligibleReason };

// SQL fragments: a Purchase is a Team Purchase exactly when it has coupons.
const isTeamPurchase = sql`exists (select 1 from ${coupons} where ${coupons.purchaseId} = ${purchases.id})`;
const isPersonalPurchase = sql`not ${isTeamPurchase}`;
const isRefundedPurchase = sql`exists (select 1 from ${refunds} where ${refunds.purchaseId} = ${purchases.id} and ${refunds.status} = ${RefundStatus.Approved})`;

function getPurchaseById(purchaseId: number) {
  return db.select().from(purchases).where(eq(purchases.id, purchaseId)).get();
}

/** The user's latest Personal Purchase of a course. */
function getLatestPersonalPurchase(userId: number, courseId: number) {
  return db
    .select()
    .from(purchases)
    .where(
      and(
        eq(purchases.userId, userId),
        eq(purchases.courseId, courseId),
        isPersonalPurchase
      )
    )
    .orderBy(sql`${purchases.createdAt} desc`)
    .get();
}

function getTeamSeats(purchaseId: number) {
  return db
    .select({ redeemedAt: coupons.redeemedAt, refundId: coupons.refundId })
    .from(coupons)
    .where(eq(coupons.purchaseId, purchaseId))
    .all();
}

/** A Refund Request on this Purchase that blocks a new one, if any. */
function getBlockingRefundStatus(purchaseId: number): RefundStatus | null {
  const row = db
    .select({ status: refunds.status })
    .from(refunds)
    .where(
      and(
        eq(refunds.purchaseId, purchaseId),
        inArray(refunds.status, [RefundStatus.Requested, RefundStatus.Approved])
      )
    )
    .get();
  return row?.status ?? null;
}

function getLessonIdsForCourse(courseId: number): number[] {
  return db
    .select({ id: lessons.id })
    .from(lessons)
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .where(eq(modules.courseId, courseId))
    .all()
    .map((row) => row.id);
}

function getCompletedLessonCount(userId: number, lessonIds: number[]): number {
  if (lessonIds.length === 0) return 0;

  const result = db
    .select({ count: sql<number>`count(*)` })
    .from(lessonProgress)
    .where(
      and(
        eq(lessonProgress.userId, userId),
        eq(lessonProgress.status, LessonProgressStatus.Completed),
        inArray(lessonProgress.lessonId, lessonIds)
      )
    )
    .get();

  return result?.count ?? 0;
}

/** Watched Time: the furthest point reached in each lesson, summed. */
function getWatchedTimeSeconds(userId: number, lessonIds: number[]): number {
  if (lessonIds.length === 0) return 0;

  return db
    .select({
      furthest: sql<number>`max(${videoWatchEvents.positionSeconds})`,
    })
    .from(videoWatchEvents)
    .where(
      and(
        eq(videoWatchEvents.userId, userId),
        inArray(videoWatchEvents.lessonId, lessonIds)
      )
    )
    .groupBy(videoWatchEvents.lessonId)
    .all()
    .reduce((total, row) => total + row.furthest, 0);
}

/**
 * Refund Eligibility for one specific Purchase, as seen by `userId`. Personal
 * and Team Purchases share the Refund Window; Watched Time and completion only
 * apply to a Personal Purchase, and a Team Purchase needs Unclaimed Team Seats.
 */
export function getRefundEligibilityForPurchase(
  userId: number,
  purchaseId: number,
  today: Date = new Date()
): RefundEligibility {
  const purchase = getPurchaseById(purchaseId);
  if (!purchase || purchase.userId !== userId) {
    return { eligible: false, reason: "no_purchase" };
  }

  const blocking = getBlockingRefundStatus(purchase.id);
  if (blocking === RefundStatus.Requested) {
    return { eligible: false, reason: "already_requested" };
  }
  if (blocking === RefundStatus.Approved) {
    return { eligible: false, reason: "already_refunded" };
  }

  if (!isWithinRefundWindow(new Date(purchase.createdAt), today)) {
    return { eligible: false, reason: "outside_refund_window" };
  }

  const seats = getTeamSeats(purchase.id);

  if (seats.length > 0) {
    const unclaimed = seats.filter(isUnclaimedSeat).length;
    if (unclaimed === 0) {
      return { eligible: false, reason: "no_unclaimed_seats" };
    }
    return {
      eligible: true,
      purchase,
      refundAmount: teamRefundAmount(purchase.amountPaid, seats.length, unclaimed),
      teamSeats: {
        count: unclaimed,
        seatPrice: seatPrice(purchase.amountPaid, seats.length),
      },
    };
  }

  const lessonIds = getLessonIdsForCourse(purchase.courseId);

  if (
    lessonIds.length > 0 &&
    getCompletedLessonCount(userId, lessonIds) / lessonIds.length >=
      MAX_COMPLETED_LESSON_SHARE
  ) {
    return { eligible: false, reason: "completed_too_much" };
  }

  if (getWatchedTimeSeconds(userId, lessonIds) >= MAX_WATCHED_TIME_SECONDS) {
    return { eligible: false, reason: "watched_too_much" };
  }

  return {
    eligible: true,
    purchase,
    refundAmount: purchase.amountPaid,
    teamSeats: null,
  };
}

/**
 * Refund Eligibility for a Student's latest Personal Purchase of a course, for
 * the course page's "Request a refund" button.
 */
export function getRefundEligibility(
  userId: number,
  courseId: number,
  today: Date = new Date()
): RefundEligibility {
  const purchase = getLatestPersonalPurchase(userId, courseId);
  if (!purchase) return { eligible: false, reason: "no_purchase" };
  return getRefundEligibilityForPurchase(userId, purchase.id, today);
}

export class RefundRequestError extends Error {
  constructor(readonly reason: RefundIneligibleReason) {
    super(`Cannot request a refund: ${reason}`);
    this.name = "RefundRequestError";
  }
}

export class RefundResolutionError extends Error {
  constructor(readonly reason: RefundResolutionFailure) {
    super(`Cannot resolve refund request: ${reason}`);
    this.name = "RefundResolutionError";
  }
}

/**
 * For loaders and actions: rethrow a refund error as an HTTP response the
 * route's error boundary can show. Anything else is rethrown unchanged.
 */
export function throwRefundErrorAsResponse(error: unknown): never {
  if (error instanceof RefundRequestError) {
    const { message, status } = REFUND_INELIGIBLE_RESPONSES[error.reason];
    throw data(message, { status });
  }
  if (error instanceof RefundResolutionError) {
    const { message, status } = REFUND_RESOLUTION_FAILURE_RESPONSES[error.reason];
    throw data(message, { status });
  }
  throw error;
}

function getBuyerDetails(purchaseId: number) {
  return db
    .select({
      buyerName: users.name,
      buyerEmail: users.email,
      courseTitle: courses.title,
    })
    .from(purchases)
    .innerJoin(users, eq(purchases.userId, users.id))
    .innerJoin(courses, eq(purchases.courseId, courses.id))
    .where(eq(purchases.id, purchaseId))
    .get();
}

/**
 * A Buyer requests a Refund for one of their Purchases. For a Team Purchase,
 * the Unclaimed Team Seats are locked until an Admin resolves the request.
 */
export function requestRefund(
  userId: number,
  purchaseId: number,
  reason: string,
  today: Date = new Date()
) {
  const eligibility = getRefundEligibilityForPurchase(userId, purchaseId, today);
  if (!eligibility.eligible) {
    throw new RefundRequestError(eligibility.reason);
  }

  const buyer = getBuyerDetails(purchaseId);
  if (!buyer) throw new RefundRequestError("no_purchase");

  const { refundAmount, teamSeats } = eligibility;

  const refundRequest = db.transaction((tx) => {
    const created = tx
      .insert(refunds)
      .values({ purchaseId, status: RefundStatus.Requested, reason })
      .returning()
      .get();

    if (teamSeats) {
      tx.update(coupons)
        .set({ refundId: created.id })
        .where(
          and(
            eq(coupons.purchaseId, purchaseId),
            isNull(coupons.redeemedAt),
            isNull(coupons.refundId)
          )
        )
        .run();
    }

    return created;
  });

  return {
    refundRequest,
    refundAmount,
    email: buildRefundRequestedEmail({ ...buyer, refundAmount, teamSeats }),
  };
}

/**
 * What a Refund Request covers. For a Team Refund: the seats it locked, at the
 * Seat Price. For a Personal Purchase: the amount paid.
 */
function getRefundCoverage(
  refundRequestId: number,
  purchaseId: number,
  amountPaid: number
): { refundAmount: number; teamSeats: TeamSeats | null } {
  const seats = getTeamSeats(purchaseId);
  if (seats.length === 0) return { refundAmount: amountPaid, teamSeats: null };

  const count = seats.filter((seat) => seat.refundId === refundRequestId).length;
  return {
    refundAmount: teamRefundAmount(amountPaid, seats.length, count),
    teamSeats: { count, seatPrice: seatPrice(amountPaid, seats.length) },
  };
}

/**
 * Whether the Student still pays for the course some other way than this
 * Purchase: another Personal Purchase that hasn't been refunded, or a Claimed
 * Team Seat. If so, refunding this Purchase must not end their Enrollment.
 */
function hasOtherPaidAccess(
  studentId: number,
  courseId: number,
  refundedPurchaseId: number
): boolean {
  const otherPurchase = db
    .select({ id: purchases.id })
    .from(purchases)
    .where(
      and(
        eq(purchases.userId, studentId),
        eq(purchases.courseId, courseId),
        ne(purchases.id, refundedPurchaseId),
        isPersonalPurchase,
        sql`not ${isRefundedPurchase}`
      )
    )
    .get();

  return otherPurchase !== undefined || hasClaimedTeamSeat(studentId, courseId);
}

function isAdmin(userId: number): boolean {
  const user = db
    .select({ role: users.role })
    .from(users)
    .where(eq(users.id, userId))
    .get();
  return user?.role === UserRole.Admin;
}

export type RefundDecision = "approve" | "decline";

/**
 * An Admin approves or declines a Requested Refund Request. The route checks
 * the Admin role too; this check keeps the rule true for every caller.
 */
export function resolveRefundRequest(
  refundRequestId: number,
  decision: RefundDecision,
  adminUserId: number
) {
  if (!isAdmin(adminUserId)) {
    throw new RefundResolutionError("not_admin");
  }

  const request = db
    .select({
      status: refunds.status,
      purchaseId: purchases.id,
      buyerId: purchases.userId,
      courseId: purchases.courseId,
      amountPaid: purchases.amountPaid,
    })
    .from(refunds)
    .innerJoin(purchases, eq(refunds.purchaseId, purchases.id))
    .where(eq(refunds.id, refundRequestId))
    .get();

  if (!request) {
    throw new RefundResolutionError("not_found");
  }

  if (request.status !== RefundStatus.Requested) {
    throw new RefundResolutionError("not_requested");
  }

  const buyer = getBuyerDetails(request.purchaseId);
  if (!buyer) throw new RefundResolutionError("not_found");

  const { refundAmount, teamSeats } = getRefundCoverage(
    refundRequestId,
    request.purchaseId,
    request.amountPaid
  );
  const resolved = {
    resolvedAt: new Date().toISOString(),
    resolvedByUserId: adminUserId,
  };

  if (decision === "decline") {
    // Declining a Team Refund unlocks its seats so they can be claimed again.
    const refundRequest = db.transaction((tx) => {
      tx.update(coupons)
        .set({ refundId: null })
        .where(eq(coupons.refundId, refundRequestId))
        .run();

      return tx
        .update(refunds)
        .set({ status: RefundStatus.Declined, ...resolved })
        .where(eq(refunds.id, refundRequestId))
        .returning()
        .get();
    });

    return {
      refundRequest,
      email: buildRefundDeclinedEmail({ ...buyer, teamSeats }),
    };
  }

  // Approval records the Refund. For a Personal Purchase it also ends the
  // Student's Enrollment, unless they still pay for the course another way.
  // A Team Refund leaves everyone's Enrollment alone; its locked seats stay
  // cancelled.
  return db.transaction((tx) => {
    if (
      !teamSeats &&
      !hasOtherPaidAccess(request.buyerId, request.courseId, request.purchaseId)
    ) {
      tx.delete(enrollments)
        .where(
          and(
            eq(enrollments.userId, request.buyerId),
            eq(enrollments.courseId, request.courseId)
          )
        )
        .run();
    }

    const refundRequest = tx
      .update(refunds)
      .set({
        status: RefundStatus.Approved,
        amountRefunded: refundAmount,
        ...resolved,
      })
      .where(eq(refunds.id, refundRequestId))
      .returning()
      .get();

    return {
      refundRequest,
      email: buildRefundApprovedEmail({ ...buyer, refundAmount, teamSeats }),
    };
  });
}

/**
 * Requested Refund Requests, oldest first, with what each covers. All of them
 * for the Admin refunds screen, or one Buyer's for their settings page.
 */
export function listRequestedRefundRequests(buyerUserId?: number) {
  const rows = db
    .select({
      id: refunds.id,
      purchaseId: purchases.id,
      amountPaid: purchases.amountPaid,
      reason: refunds.reason,
      requestedAt: refunds.requestedAt,
      purchasedAt: purchases.createdAt,
      buyerName: users.name,
      buyerEmail: users.email,
      courseTitle: courses.title,
      courseSlug: courses.slug,
    })
    .from(refunds)
    .innerJoin(purchases, eq(refunds.purchaseId, purchases.id))
    .innerJoin(users, eq(purchases.userId, users.id))
    .innerJoin(courses, eq(purchases.courseId, courses.id))
    .where(
      and(
        eq(refunds.status, RefundStatus.Requested),
        buyerUserId === undefined ? undefined : eq(purchases.userId, buyerUserId)
      )
    )
    .orderBy(refunds.requestedAt)
    .all();

  return rows.map(({ purchaseId, amountPaid, ...row }) => ({
    ...row,
    ...getRefundCoverage(row.id, purchaseId, amountPaid),
  }));
}

/**
 * The Team Purchases a Team Admin made, with their seats and either a
 * Requested Team Refund or what a Team Refund would cover now. For /team.
 */
export function listTeamPurchasesForBuyer(
  userId: number,
  today: Date = new Date()
) {
  const rows = db
    .select({
      purchaseId: purchases.id,
      purchasedAt: purchases.createdAt,
      courseTitle: courses.title,
    })
    .from(purchases)
    .innerJoin(courses, eq(purchases.courseId, courses.id))
    .where(and(eq(purchases.userId, userId), isTeamPurchase))
    .orderBy(sql`${purchases.createdAt} desc`)
    .all();

  return rows.map((row) => {
    const seats = getTeamSeats(row.purchaseId);
    const eligibility = getRefundEligibilityForPurchase(
      userId,
      row.purchaseId,
      today
    );
    return {
      ...row,
      totalSeats: seats.length,
      claimedSeats: seats.filter((seat) => seat.redeemedAt !== null).length,
      refundStatus: getBlockingRefundStatus(row.purchaseId),
      refundOffer:
        eligibility.eligible && eligibility.teamSeats
          ? {
              refundAmount: eligibility.refundAmount,
              teamSeats: eligibility.teamSeats,
            }
          : null,
    };
  });
}
