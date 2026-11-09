// Runs against a real, migrated in-memory SQLite database.
process.env.DATABASE_PATH = ":memory:";

import { beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { db, getSqlite } from "~/db";
import {
  categories,
  coupons,
  courses,
  enrollments,
  purchases,
  refunds,
  teamMembers,
  teams,
  users,
  CourseStatus,
  TeamMemberRole,
  UserRole,
} from "~/db/schema";
import { isUserEnrolled } from "~/lib/access.server";
import { redeemCoupon } from "~/lib/coupons.server";
import {
  RefundRequestError,
  RefundResolutionError,
  requestRefund,
  resolveRefundRequest,
} from "~/lib/refunds.server";

beforeAll(() => {
  migrate(drizzle(getSqlite()), { migrationsFolder: "drizzle" });
});

let sequence = 0;

/** A Student who bought a course, is enrolled, and has a Requested Refund Request. */
function arrangeRequestedRefund({ amountPaid = 4900 } = {}) {
  sequence += 1;
  const n = sequence;

  const admin = db
    .insert(users)
    .values({ name: "Admin", email: `admin${n}@example.com`, role: UserRole.Admin })
    .returning()
    .get();
  const instructor = db
    .insert(users)
    .values({
      name: "Instructor",
      email: `instructor${n}@example.com`,
      role: UserRole.Instructor,
    })
    .returning()
    .get();
  const student = db
    .insert(users)
    .values({ name: "Ada", email: `ada${n}@example.com`, role: UserRole.Student })
    .returning()
    .get();
  const category = db
    .insert(categories)
    .values({ name: `Category ${n}`, slug: `category-${n}` })
    .returning()
    .get();
  const course = db
    .insert(courses)
    .values({
      title: "Intro to TypeScript",
      slug: `intro-to-typescript-${n}`,
      description: "Learn TypeScript.",
      salesCopy: "Buy it.",
      instructorId: instructor.id,
      categoryId: category.id,
      status: CourseStatus.Published,
      price: 9900,
    })
    .returning()
    .get();
  const purchase = db
    .insert(purchases)
    .values({ userId: student.id, courseId: course.id, amountPaid })
    .returning()
    .get();
  db.insert(enrollments)
    .values({ userId: student.id, courseId: course.id })
    .run();
  const refundRequest = db
    .insert(refunds)
    .values({ purchaseId: purchase.id, reason: "Not what I expected." })
    .returning()
    .get();

  return { admin, instructor, student, course, purchase, refundRequest };
}

describe("resolveRefundRequest", () => {
  it("approving ends the Student's access to the course", () => {
    const { admin, student, course, refundRequest } = arrangeRequestedRefund();

    resolveRefundRequest(refundRequest.id, "approve", admin.id);

    expect(isUserEnrolled(student.id, course.id)).toBe(false);
  });

  it("approving records the Refund Amount and returns the Refund Approved email", () => {
    const { admin, student, refundRequest } = arrangeRequestedRefund({
      amountPaid: 2970,
    });

    const result = resolveRefundRequest(refundRequest.id, "approve", admin.id);

    expect(result.refundRequest.status).toBe("approved");
    expect(result.refundRequest.amountRefunded).toBe(2970);
    expect(result.refundRequest.resolvedByUserId).toBe(admin.id);
    expect(result.email.to).toBe(student.email);
    expect(result.email.subject).toBe("Refund approved — Intro to TypeScript");
    expect(result.email.body).toContain("$29.70");
  });

  it("declining keeps the Student's access and returns the Refund Declined email", () => {
    const { admin, student, course, refundRequest } = arrangeRequestedRefund();

    const result = resolveRefundRequest(refundRequest.id, "decline", admin.id);

    expect(isUserEnrolled(student.id, course.id)).toBe(true);
    expect(result.refundRequest.status).toBe("declined");
    expect(result.refundRequest.amountRefunded).toBeNull();
    expect(result.email.to).toBe(student.email);
    expect(result.email.subject).toBe("Refund declined — Intro to TypeScript");
  });

  it("only an Admin can resolve a Refund Request", () => {
    const { instructor, student, course, refundRequest } =
      arrangeRequestedRefund();

    expect(() =>
      resolveRefundRequest(refundRequest.id, "approve", instructor.id)
    ).toThrow(RefundResolutionError);
    expect(isUserEnrolled(student.id, course.id)).toBe(true);
  });

  it("a declined Refund Request cannot then be approved", () => {
    const { admin, student, course, refundRequest } = arrangeRequestedRefund();
    resolveRefundRequest(refundRequest.id, "decline", admin.id);

    expect(() =>
      resolveRefundRequest(refundRequest.id, "approve", admin.id)
    ).toThrow(RefundResolutionError);
    expect(isUserEnrolled(student.id, course.id)).toBe(true);
  });
});

function insertUser(name: string, role: UserRole) {
  sequence += 1;
  return db
    .insert(users)
    .values({ name, email: `user${sequence}@example.com`, role })
    .returning()
    .get();
}

/**
 * A Team Admin bought `seats` Team Seats at `seatPrice` each, and `claimed` of
 * them have been claimed by Students who are now enrolled.
 */
function arrangeTeamPurchase({
  seats = 5,
  claimed = 2,
  seatPrice = 2900,
  amountPaid,
  purchasedAt = new Date().toISOString(),
}: {
  seats?: number;
  claimed?: number;
  seatPrice?: number;
  amountPaid?: number;
  purchasedAt?: string;
} = {}) {
  sequence += 1;
  const n = sequence;

  const admin = insertUser("Admin", UserRole.Admin);
  const instructor = insertUser("Instructor", UserRole.Instructor);
  const teamAdmin = insertUser("Bea", UserRole.Student);
  const category = db
    .insert(categories)
    .values({ name: `Category ${n}`, slug: `category-${n}` })
    .returning()
    .get();
  const course = db
    .insert(courses)
    .values({
      title: "Intro to TypeScript",
      slug: `intro-to-typescript-${n}`,
      description: "Learn TypeScript.",
      salesCopy: "Buy it.",
      instructorId: instructor.id,
      categoryId: category.id,
      status: CourseStatus.Published,
      price: 9900,
    })
    .returning()
    .get();
  const team = db.insert(teams).values({}).returning().get();
  db.insert(teamMembers)
    .values({ teamId: team.id, userId: teamAdmin.id, role: TeamMemberRole.Admin })
    .run();
  const purchase = db
    .insert(purchases)
    .values({
      userId: teamAdmin.id,
      courseId: course.id,
      amountPaid: amountPaid ?? seatPrice * seats,
      createdAt: purchasedAt,
    })
    .returning()
    .get();

  const seatCodes: string[] = [];
  const claimedBy: number[] = [];
  for (let i = 0; i < seats; i++) {
    const code = `seat-${n}-${i}`;
    seatCodes.push(code);
    const isClaimed = i < claimed;
    let redeemedByUserId: number | null = null;
    if (isClaimed) {
      const student = insertUser(`Student ${i}`, UserRole.Student);
      db.insert(enrollments)
        .values({ userId: student.id, courseId: course.id })
        .run();
      redeemedByUserId = student.id;
      claimedBy.push(student.id);
    }
    db.insert(coupons)
      .values({
        teamId: team.id,
        courseId: course.id,
        code,
        purchaseId: purchase.id,
        redeemedByUserId,
        redeemedAt: isClaimed ? new Date().toISOString() : null,
      })
      .run();
  }

  return { admin, teamAdmin, team, course, purchase, seatCodes, claimedBy };
}

describe("requestRefund for a Team Purchase", () => {
  it("covers only the Unclaimed Team Seats, at the Seat Price", () => {
    const { teamAdmin, purchase } = arrangeTeamPurchase({
      seats: 5,
      claimed: 2,
      seatPrice: 2900,
    });

    const result = requestRefund(teamAdmin.id, purchase.id, "We hired fewer people.");

    expect(result.refundAmount).toBe(8700);
    expect(result.email.subject).toBe("Refund requested — Intro to TypeScript");
    expect(result.email.body).toContain("$87.00");
    expect(result.email.body).toContain("Covers 3 unclaimed seats at $29.00 each.");
  });

  it("only the Team Admin who made the Purchase can request it", () => {
    const { team, purchase } = arrangeTeamPurchase();
    const otherTeamAdmin = insertUser("Cal", UserRole.Student);
    db.insert(teamMembers)
      .values({
        teamId: team.id,
        userId: otherTeamAdmin.id,
        role: TeamMemberRole.Admin,
      })
      .run();

    expect(() =>
      requestRefund(otherTeamAdmin.id, purchase.id, "Not mine to ask.")
    ).toThrow(RefundRequestError);
  });

  it("cannot be requested when every Team Seat is claimed", () => {
    const { teamAdmin, purchase } = arrangeTeamPurchase({ seats: 3, claimed: 3 });

    expect(() =>
      requestRefund(teamAdmin.id, purchase.id, "Everyone joined.")
    ).toThrow(RefundRequestError);
  });

  it("cannot be requested after the Refund Window has closed", () => {
    const { teamAdmin, purchase } = arrangeTeamPurchase({
      purchasedAt: new Date(2026, 0, 1, 12, 0).toISOString(),
    });

    expect(() =>
      requestRefund(
        teamAdmin.id,
        purchase.id,
        "Too late.",
        new Date(2026, 0, 16, 9, 0)
      )
    ).toThrow(RefundRequestError);
  });
});

describe("resolveRefundRequest for a Team Refund", () => {
  it("approving changes nobody's access and refunds only the locked seats", () => {
    const { admin, teamAdmin, course, purchase, claimedBy } =
      arrangeTeamPurchase({ seats: 5, claimed: 2, seatPrice: 2900 });
    // The Team Admin also has their own Personal Purchase of the course.
    db.insert(purchases)
      .values({ userId: teamAdmin.id, courseId: course.id, amountPaid: 9900 })
      .run();
    db.insert(enrollments)
      .values({ userId: teamAdmin.id, courseId: course.id })
      .run();
    const { refundRequest } = requestRefund(
      teamAdmin.id,
      purchase.id,
      "We hired fewer people."
    );

    const result = resolveRefundRequest(refundRequest.id, "approve", admin.id);

    expect(isUserEnrolled(teamAdmin.id, course.id)).toBe(true);
    for (const studentId of claimedBy) {
      expect(isUserEnrolled(studentId, course.id)).toBe(true);
    }
    expect(result.refundRequest.amountRefunded).toBe(8700);
    expect(result.email.body).toContain("$87.00");
    expect(result.email.body).toContain("Covers 3 unclaimed seats at $29.00 each.");
  });
});

describe("claiming a Team Seat during and after a Team Refund", () => {
  it("a seat locked by a Requested Team Refund cannot be claimed", () => {
    const { teamAdmin, purchase, seatCodes } = arrangeTeamPurchase({
      seats: 3,
      claimed: 1,
    });
    requestRefund(teamAdmin.id, purchase.id, "We hired fewer people.");
    const newcomer = insertUser("Dee", UserRole.Student);

    const result = redeemCoupon(seatCodes[2], newcomer.id, "");

    expect(result.ok).toBe(false);
  });

  it("declining a Team Refund makes its seats claimable again", () => {
    const { admin, teamAdmin, course, purchase, seatCodes } =
      arrangeTeamPurchase({ seats: 3, claimed: 1 });
    const { refundRequest } = requestRefund(
      teamAdmin.id,
      purchase.id,
      "We hired fewer people."
    );
    resolveRefundRequest(refundRequest.id, "decline", admin.id);
    const newcomer = insertUser("Dee", UserRole.Student);

    const result = redeemCoupon(seatCodes[2], newcomer.id, "");

    expect(result.ok).toBe(true);
    expect(isUserEnrolled(newcomer.id, course.id)).toBe(true);
  });

  it("a seat cancelled by an Approved Team Refund cannot be claimed", () => {
    const { admin, teamAdmin, purchase, seatCodes } = arrangeTeamPurchase({
      seats: 3,
      claimed: 1,
    });
    const { refundRequest } = requestRefund(
      teamAdmin.id,
      purchase.id,
      "We hired fewer people."
    );
    resolveRefundRequest(refundRequest.id, "approve", admin.id);
    const newcomer = insertUser("Dee", UserRole.Student);

    const result = redeemCoupon(seatCodes[2], newcomer.id, "");

    expect(result.ok).toBe(false);
  });
});

describe("review fixes", () => {
  it("a Refunded Purchase cannot be refunded again", () => {
    const { admin, student, purchase, refundRequest } = arrangeRequestedRefund();
    resolveRefundRequest(refundRequest.id, "approve", admin.id);

    expect(() =>
      requestRefund(student.id, purchase.id, "Asking a second time.")
    ).toThrow(RefundRequestError);
  });

  it("approving a Personal Purchase refund keeps access the Student holds through a Claimed Team Seat", () => {
    const { admin, student, course, refundRequest } = arrangeRequestedRefund();
    const teamBuyer = insertUser("Eve", UserRole.Student);
    const team = db.insert(teams).values({}).returning().get();
    const teamPurchase = db
      .insert(purchases)
      .values({ userId: teamBuyer.id, courseId: course.id, amountPaid: 2900 })
      .returning()
      .get();
    db.insert(coupons)
      .values({
        teamId: team.id,
        courseId: course.id,
        code: `review-seat-${refundRequest.id}`,
        purchaseId: teamPurchase.id,
        redeemedByUserId: student.id,
        redeemedAt: new Date().toISOString(),
      })
      .run();

    resolveRefundRequest(refundRequest.id, "approve", admin.id);

    expect(isUserEnrolled(student.id, course.id)).toBe(true);
  });

  it("a Team Refund is a whole number of cents when the Seat Price doesn't divide evenly", () => {
    const { admin, teamAdmin, purchase } = arrangeTeamPurchase({
      seats: 3,
      claimed: 1,
      amountPaid: 10000,
    });

    const requested = requestRefund(teamAdmin.id, purchase.id, "We hired fewer people.");
    const { refundRequest } = requested;
    const approved = resolveRefundRequest(refundRequest.id, "approve", admin.id);

    expect(requested.refundAmount).toBe(6667);
    expect(approved.refundRequest.amountRefunded).toBe(6667);
    expect(approved.email.body).toContain("Covers 2 unclaimed seats at $33.33 each.");
  });
});

