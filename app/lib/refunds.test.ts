import { describe, it, expect } from "vitest";
import {
  buildRefundApprovedEmail,
  buildRefundDeclinedEmail,
  buildRefundRequestedEmail,
  isWithinRefundWindow,
  lastDayOfRefundWindow,
} from "./refunds";

describe("Refund Window", () => {
  const purchasedAt = new Date(2026, 0, 1, 23, 0);

  it("ends at the close of the 14th calendar day after the purchase day", () => {
    expect(lastDayOfRefundWindow(purchasedAt)).toBe("2026-01-15");
  });

  it("is open on the purchase day", () => {
    expect(isWithinRefundWindow(purchasedAt, new Date(2026, 0, 1, 23, 30))).toBe(
      true
    );
  });

  it("is open all day on the last day, even after the purchase hour", () => {
    expect(isWithinRefundWindow(purchasedAt, new Date(2026, 0, 15, 23, 59))).toBe(
      true
    );
  });

  it("is closed the day after the last day", () => {
    expect(isWithinRefundWindow(purchasedAt, new Date(2026, 0, 16, 0, 1))).toBe(
      false
    );
  });
});

describe("buildRefundRequestedEmail", () => {
  const email = buildRefundRequestedEmail({
    buyerName: "Ada",
    buyerEmail: "ada@example.com",
    courseTitle: "Intro to TypeScript",
    refundAmount: 4900,
    teamSeats: null,
  });

  it("uses the glossary subject line", () => {
    expect(email.subject).toBe("Refund requested — Intro to TypeScript");
  });

  it("never uses banned words", () => {
    expect(`${email.subject} ${email.body}`).not.toMatch(
      /reversal|chargeback|cancel/i
    );
  });
});

describe("Refund Approved and Declined emails", () => {
  const student = {
    buyerName: "Ada",
    buyerEmail: "ada@example.com",
    courseTitle: "Intro to TypeScript",
  };
  const approved = buildRefundApprovedEmail({
    ...student,
    refundAmount: 4900,
    teamSeats: null,
  });
  const declined = buildRefundDeclinedEmail({ ...student, teamSeats: null });

  it("use the glossary subject lines", () => {
    expect(approved.subject).toBe("Refund approved — Intro to TypeScript");
    expect(declined.subject).toBe("Refund declined — Intro to TypeScript");
  });

  it("tell the Student what happens to their money and access", () => {
    expect(approved.body).toContain("$49.00");
    expect(approved.body).toContain("access to the course has ended");
    expect(declined.body).toContain("keep your access");
  });

  it("never use banned words", () => {
    for (const email of [approved, declined]) {
      expect(`${email.subject} ${email.body}`).not.toMatch(
        /reversal|chargeback|cancel|pending/i
      );
    }
  });
});
