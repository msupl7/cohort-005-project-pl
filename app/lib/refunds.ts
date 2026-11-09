// Refund rules and copy shared by the server and the pages. Terms follow
// GLOSSARY.md: Refund Request, Refund Window, Refund Eligibility, Refund
// Amount, Seat Price, Watched Time, Buyer.

import { z } from "zod";
import { formatPrice } from "~/lib/utils";

export const REFUND_WINDOW_DAYS = 14;
export const MAX_WATCHED_TIME_SECONDS = 2 * 60 * 60;
export const MAX_COMPLETED_LESSON_SHARE = 0.5;
export const REFUND_REASON_MIN_LENGTH = 10;
export const REFUND_REASON_MAX_LENGTH = 1000;

export type RefundIneligibleReason =
  | "no_purchase"
  | "already_requested"
  | "already_refunded"
  | "outside_refund_window"
  | "completed_too_much"
  | "watched_too_much"
  | "no_unclaimed_seats";

export type RefundResolutionFailure = "not_found" | "not_admin" | "not_requested";

/** The Buyer's own words when they submit a Refund Request. */
export const refundReasonSchema = z
  .string()
  .trim()
  .min(
    REFUND_REASON_MIN_LENGTH,
    "Tell us a little more about why you want a refund."
  )
  .max(
    REFUND_REASON_MAX_LENGTH,
    `Please keep your reason under ${REFUND_REASON_MAX_LENGTH} characters.`
  );

type ErrorResponse = { message: string; status: number };

/** What to tell the Buyer, and which HTTP status to use, when they can't request a refund. */
export const REFUND_INELIGIBLE_RESPONSES: Record<
  RefundIneligibleReason,
  ErrorResponse
> = {
  no_purchase: { message: "You have not bought this course.", status: 403 },
  already_requested: {
    message: "You have already requested a refund for this purchase.",
    status: 409,
  },
  already_refunded: {
    message: "This purchase has already been refunded.",
    status: 409,
  },
  outside_refund_window: {
    message: `The ${REFUND_WINDOW_DAYS}-day refund window has closed.`,
    status: 403,
  },
  completed_too_much: {
    message: "You have completed too much of this course to request a refund.",
    status: 403,
  },
  watched_too_much: {
    message: `You have watched ${MAX_WATCHED_TIME_SECONDS / 3600} hours or more of this course, so it cannot be refunded.`,
    status: 403,
  },
  no_unclaimed_seats: {
    message:
      "Every seat on this purchase has been claimed, so there is nothing to refund.",
    status: 403,
  },
};

/** What to tell an Admin, and which HTTP status to use, when a decision can't be applied. */
export const REFUND_RESOLUTION_FAILURE_RESPONSES: Record<
  RefundResolutionFailure,
  ErrorResponse
> = {
  not_admin: { message: "Only admins can resolve refund requests.", status: 403 },
  not_found: { message: "Refund request not found.", status: 404 },
  not_requested: {
    message: "This refund request has already been approved or declined.",
    status: 409,
  },
};

/** The seats a Team Refund covers, and the Seat Price of each. */
export type TeamSeats = { count: number; seatPrice: number };

/** Seat Price: what one Team Seat cost, rounded to the nearest cent. */
export function seatPrice(amountPaid: number, totalSeats: number): number {
  return Math.round(amountPaid / totalSeats);
}

/**
 * The Refund Amount for `count` of a Team Purchase's seats, rounded once on
 * the total so refunding every seat gives back exactly what was paid.
 */
export function teamRefundAmount(
  amountPaid: number,
  totalSeats: number,
  count: number
): number {
  return Math.round((amountPaid * count) / totalSeats);
}

function teamSeatsLine(teamSeats: TeamSeats | null): string[] {
  if (!teamSeats) return [];
  const seats = teamSeats.count === 1 ? "unclaimed seat" : "unclaimed seats";
  return [
    `Covers ${teamSeats.count} ${seats} at ${formatPrice(teamSeats.seatPrice)} each.`,
  ];
}

// The Refund Window is counted in whole calendar days, not hours — someone
// who buys at 23:00 still gets the whole of their fourteenth day.
export function calendarDay(when: Date): string {
  const month = String(when.getMonth() + 1).padStart(2, "0");
  const day = String(when.getDate()).padStart(2, "0");
  return `${when.getFullYear()}-${month}-${day}`;
}

export function lastDayOfRefundWindow(purchasedAt: Date): string {
  const deadline = new Date(purchasedAt);
  deadline.setDate(deadline.getDate() + REFUND_WINDOW_DAYS);
  return calendarDay(deadline);
}

export function isWithinRefundWindow(purchasedAt: Date, today: Date): boolean {
  const todayDay = calendarDay(today);
  return (
    todayDay >= calendarDay(purchasedAt) &&
    todayDay <= lastDayOfRefundWindow(purchasedAt)
  );
}

/** Who a refund email goes to: the Buyer of the Purchase. */
export type RefundEmailRecipient = {
  buyerName: string;
  buyerEmail: string;
  courseTitle: string;
};

export type Email = { to: string; subject: string; body: string };

function email(
  recipient: RefundEmailRecipient,
  subject: string,
  lines: string[]
): Email {
  return {
    to: recipient.buyerEmail,
    subject: `${subject} — ${recipient.courseTitle}`,
    body: [
      `Hi ${recipient.buyerName},`,
      "",
      ...lines,
      "",
      "— The Cadence team",
    ].join("\n"),
  };
}

/** The Refund Requested email, sent when a Buyer submits a Refund Request. */
export function buildRefundRequestedEmail(
  input: RefundEmailRecipient & {
    refundAmount: number;
    teamSeats: TeamSeats | null;
  }
): Email {
  return email(input, "Refund requested", [
    `We have your refund request for "${input.courseTitle}".`,
    `If it is approved, we will refund ${formatPrice(input.refundAmount)}.`,
    ...teamSeatsLine(input.teamSeats),
    "",
    "We review every refund request by hand. You do not need to do anything else — we will email you again when it has been approved or declined.",
  ]);
}

/** The Refund Approved email, sent when an Admin approves a Refund Request. */
export function buildRefundApprovedEmail(
  input: RefundEmailRecipient & {
    refundAmount: number;
    teamSeats: TeamSeats | null;
  }
): Email {
  const refunding = `We are refunding ${formatPrice(input.refundAmount)} to the card you paid with.`;
  return email(input, "Refund approved", [
    `We have approved your refund request for "${input.courseTitle}".`,
    ...(input.teamSeats
      ? [
          refunding,
          ...teamSeatsLine(input.teamSeats),
          "Those seats are cancelled and their links no longer work. Anyone who already claimed a seat keeps their access.",
        ]
      : [`${refunding} Your access to the course has ended.`]),
  ]);
}

/** The Refund Declined email, sent when an Admin declines a Refund Request. */
export function buildRefundDeclinedEmail(
  input: RefundEmailRecipient & { teamSeats: TeamSeats | null }
): Email {
  return email(input, "Refund declined", [
    `We have declined your refund request for "${input.courseTitle}".`,
    ...(input.teamSeats
      ? [
          ...teamSeatsLine(input.teamSeats),
          "Nothing has been refunded, and those seats can be claimed again.",
        ]
      : ["You keep your access to the course, and nothing has been refunded."]),
  ]);
}
