# Glossary

The words we use for the domain, in the UI, in emails, and in code. When you name something covered here, use the **Term**. Never use a word listed under **Avoid**.

Scope so far: the refund lifecycle and the terms it depends on.

## The flow

1. A **Buyer** makes a **Purchase** and we get paid.
2. For a Personal Purchase, the Buyer gets an **Enrollment** and can use the course. For a Team Purchase, they get **Team Seats** to share instead.
3. The Buyer may submit a **Refund Request** while the Purchase meets **Refund Eligibility**. We send the **Refund Requested email**.
4. An **Admin** approves or declines it.
   - **Approved:** the **Refund Amount** goes back to the Buyer, and we send the **Refund Approved email**. For a Personal Purchase, the Student loses access to the course (their Enrollment ends). For a Team Refund, the refunded seats are cancelled.
   - **Declined:** nothing is refunded, nobody loses access, and we send the **Refund Declined email**.

## Refunds

| Term | Definition | Avoid | Code name |
| --- | --- | --- | --- |
| **Refund Request** | A Buyer's ask to get their money back for one specific Purchase. Has a Refund Status. A Purchase can have at most one Requested Refund Request at a time, and none once it is a Refunded Purchase. | Chargeback, Reversal, Cancellation, Cancel request | `refunds` table, `requestRefund` |
| **Refund** | The money returned to the Buyer when a Refund Request is Approved. | Reversal, Chargeback | `refunds.amountRefunded` |
| **Team Refund** | A Refund for a Team Purchase. It covers every Unclaimed Team Seat on that Purchase at once, with no picking individual seats. Requested from `/team`. | Seat refund, Partial refund | `requestRefund`, `coupons.refundId` |
| **Refund Status** | Where a Refund Request is: **Requested**, **Approved**, or **Declined**. User-facing copy reads "Refund requested", "Refund approved", "Refund declined". | Pending, Open, Raised | `RefundStatus` |
| **Requested** | Submitted by the Buyer, waiting for an Admin. For a Team Refund, its Unclaimed Team Seats are locked and can't be claimed. | Pending, Open | `RefundStatus.Requested` |
| **Approved** | An Admin accepted the request, and the Refund Amount goes back to the Buyer. For a Personal Purchase, the Student's Enrollment ends, unless they still pay for the course another way (another Personal Purchase that hasn't been refunded, or a Claimed Team Seat). For a Team Refund, the locked seats are cancelled for good and their links stop working, and nobody's Enrollment changes. | Completed, Reversed | `RefundStatus.Approved` |
| **Declined** | An Admin turned the request down, and nothing is refunded. For a Team Refund, the locked seats unlock and can be claimed again. The Buyer may submit a new Refund Request if they are still eligible under Refund Eligibility. | Rejected, Denied | `RefundStatus.Declined` |
| **Refund Amount** | What the Buyer gets back. For a Personal Purchase: the amount paid. For a Team Refund: `amountPaid` × unclaimed seats ÷ all seats, rounded once to the nearest cent, so refunding every seat gives back exactly what was paid. The locked seats fix it when the request is made. | Refundable amount, list price | `teamRefundAmount` in `app/lib/refunds.ts` |
| **Refund Window** | The period in which a Refund Request may be submitted. It ends at the close of the 14th calendar day after the purchase day. Example: bought at 23:00 on the 1st, the request can still be made all day on the 15th. Applies to Personal and Team Purchases. | Cancel window | `REFUND_WINDOW_DAYS`, `isWithinRefundWindow` in `app/lib/refunds.ts` |
| **Refund Eligibility** | Whether a Purchase may get a Refund Request. **Both kinds of Purchase:** made by this Buyer, inside the Refund Window, not already a Refunded Purchase, and no Refund Request on it is Requested. **Personal Purchase also:** the Student has completed fewer than half the course's lessons and their Watched Time is under 2 hours. **Team Purchase also:** at least one Unclaimed Team Seat remains. | Cancellation offer | `getRefundEligibility`, `getRefundEligibilityForPurchase` in `app/lib/refunds.server.ts` |
| **Refunded Purchase** | A Purchase that has an Approved Refund Request. It can't be refunded again. This is derived, not stored as a separate status. | Reversed purchase, Cancelled purchase | — |
| **Chargeback** | A dispute the Buyer raises with their card issuer or bank, which forces the money back outside our process. **Never** use this word for a Refund Request. | — | — |

## Related terms

| Term | Definition | Avoid | Code name |
| --- | --- | --- | --- |
| **Buyer** | The user who made a Purchase: a Student for a Personal Purchase, a Team Admin for a Team Purchase. Refund emails go to the Buyer. | Purchaser | `purchases.userId`, `buyerName` / `buyerEmail` |
| **Student** | A user who buys and takes courses. | Learner, Customer | `UserRole.Student` |
| **Admin** | Staff user. The only role that resolves a Refund Request, on the Refund Requests screen (`/admin/refunds`). Never use "Admin" alone to mean a Team Admin. | Team, Reviewer | `UserRole.Admin`, `requireAdmin`, `resolveRefundRequest` |
| **Instructor** | Creates and teaches a course. Does not resolve Refund Requests. | — | `UserRole.Instructor` |
| **Purchase** | One payment by a user for a course. Either a Personal Purchase or a Team Purchase. | Order, Transaction | `purchases` table |
| **Personal Purchase** | A Purchase of one place in a course, for the Buyer. The Buyer is enrolled. | Individual purchase, Single purchase | A Purchase with no `coupons` |
| **Team Purchase** | A Purchase of several Team Seats at once. The Buyer becomes a Team Admin and is not enrolled. `amountPaid` is the price of one seat × the number of seats. | Team licence, Bulk purchase | A Purchase with `coupons` |
| **Team Admin** | A user who manages a team. Only the one who made a Team Purchase can request a Team Refund for it. Always write "Team Admin", never just "Admin". | Admin, Team owner | `TeamMemberRole.Admin` |
| **Seat Price** | What one Team Seat cost on a Team Purchase: `amountPaid` ÷ the number of Team Seats, rounded to the nearest cent. Shown in copy; the Refund Amount is calculated from the total, not from the rounded Seat Price. | Unit price | `seatPrice` in `app/lib/refunds.ts` |
| **Enrollment** | A Student's access to a course. In copy for Students, "access" is fine ("you keep your access"). In code and in staff-facing terms, say Enrollment. | Seat | `enrollments` table |
| **PPP Price** | A Purchasing Power Parity price: a discounted price based on the Buyer's country tier. | Regional price | `app/lib/ppp.ts` |
| **Watched Time** | The furthest point a Student reached in each lesson of a course, added up across the course. Rewatching does not add to it, and skipping ahead does. | Watch hours, Progress | `getWatchedTimeSeconds`, `MAX_WATCHED_TIME_SECONDS` |
| **Team Seat** | One place in a course from a Team Purchase, shared as a coupon link. Its state is Unclaimed, Claimed, Locked (by a Requested Team Refund) or Cancelled (by an Approved one). | — | `coupons`, `getSeatState` in `app/lib/coupons.server.ts` |
| **Unclaimed Team Seat** | A Team Seat nobody has claimed and that isn't locked or cancelled by a Refund Request. Only these count toward a Team Refund. | Free seat, Spare seat | `isUnclaimedSeat` |
| **Claimed Team Seat** | A Team Seat a Student has redeemed, which enrolled them. It is never part of a Team Refund, and the Student who claimed it can't request a refund because they made no Purchase. | — | `coupons.redeemedAt` is set |

## Emails

| Term | Sent when | Subject |
| --- | --- | --- |
| **Refund Requested email** | A Buyer submits a Refund Request | `Refund requested — {course}` (`buildRefundRequestedEmail`) |
| **Refund Approved email** | An Admin approves a Refund Request | `Refund approved — {course}` (`buildRefundApprovedEmail`) |
| **Refund Declined email** | An Admin declines a Refund Request | `Refund declined — {course}` (`buildRefundDeclinedEmail`) |

For a Team Refund, all three emails add a line with the seat count and Seat Price, e.g. "Covers 3 unclaimed seats at $29.00 each." Team Refunds don't get separate emails. Every email goes out through `sendEmail` in `app/lib/email.server.ts`.

## Known drift

Places where the code or copy doesn't match this glossary yet. Fix them, then delete the line.

- None in naming or rules. Emails are written to the server log because no mail transport is wired up, and approving a Refund doesn't move money because there's no payment provider. Both are missing infrastructure, not naming problems.
