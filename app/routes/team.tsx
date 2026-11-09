import { useEffect, useState } from "react";
import { Link, useFetcher } from "react-router";
import { toast } from "sonner";
import { z } from "zod";
import type { Route } from "./+types/team";
import { getCurrentUserId } from "~/lib/session";
import { Card, CardContent, CardHeader } from "~/components/ui/card";
import { Button } from "~/components/ui/button";
import { Textarea } from "~/components/ui/textarea";
import { Users, BookOpen, Copy, Check, AlertTriangle } from "lucide-react";
import { data, isRouteErrorResponse } from "react-router";
import { db } from "~/db";
import {
  teams,
  teamMembers,
  coupons,
  courses,
  users,
  RefundStatus,
  TeamMemberRole,
} from "~/db/schema";
import { eq, and } from "drizzle-orm";
import { parseFormData } from "~/lib/validation";
import { formatPrice } from "~/lib/utils";
import { sendEmail } from "~/lib/email.server";
import { getSeatState, type SeatState } from "~/lib/coupons.server";
import {
  REFUND_REASON_MAX_LENGTH,
  REFUND_REASON_MIN_LENGTH,
  refundReasonSchema,
} from "~/lib/refunds";
import {
  listTeamPurchasesForBuyer,
  requestRefund,
  throwRefundErrorAsResponse,
} from "~/lib/refunds.server";

const teamRefundSchema = z.object({
  intent: z.literal("request-team-refund"),
  purchaseId: z.coerce.number().int(),
  reason: refundReasonSchema,
});

function getTeamForAdmin(userId: number) {
  const membership = db
    .select()
    .from(teamMembers)
    .where(
      and(
        eq(teamMembers.userId, userId),
        eq(teamMembers.role, TeamMemberRole.Admin)
      )
    )
    .get();

  if (!membership) return undefined;

  return db.select().from(teams).where(eq(teams.id, membership.teamId)).get();
}

function getCouponsForTeam(teamId: number) {
  return db.select().from(coupons).where(eq(coupons.teamId, teamId)).all();
}

function getCourseById(id: number) {
  return db.select().from(courses).where(eq(courses.id, id)).get();
}

function getUserById(id: number) {
  return db.select().from(users).where(eq(users.id, id)).get();
}

interface CourseStats {
  courseId: number;
  courseTitle: string;
  courseSlug: string;
  totalSeats: number;
  claimedSeats: number;
}

interface CouponRow {
  id: number;
  code: string;
  courseId: number;
  courseTitle: string;
  redeemedByEmail: string | null;
  seatState: SeatState;
  createdAt: string;
}

export function meta() {
  return [
    { title: "Team — Cadence" },
    { name: "description", content: "Manage your team's course seats" },
  ];
}

export async function loader({ request }: Route.LoaderArgs) {
  const currentUserId = await getCurrentUserId(request);

  if (!currentUserId) {
    throw data("Select a user from the DevUI panel.", { status: 401 });
  }

  const team = getTeamForAdmin(currentUserId);

  if (!team) {
    throw data("You don't have a team. Purchase team seats to create one.", {
      status: 403,
    });
  }

  const allCoupons = getCouponsForTeam(team.id);

  // Build per-course stats
  const courseMap = new Map<
    number,
    {
      courseId: number;
      courseTitle: string;
      courseSlug: string;
      total: number;
      claimed: number;
    }
  >();

  for (const coupon of allCoupons) {
    if (!courseMap.has(coupon.courseId)) {
      const course = getCourseById(coupon.courseId);
      courseMap.set(coupon.courseId, {
        courseId: coupon.courseId,
        courseTitle: course?.title ?? "Unknown Course",
        courseSlug: course?.slug ?? "",
        total: 0,
        claimed: 0,
      });
    }
    const entry = courseMap.get(coupon.courseId)!;
    entry.total++;
    if (coupon.redeemedByUserId !== null) {
      entry.claimed++;
    }
  }

  const courseStats: CourseStats[] = Array.from(courseMap.values()).map(
    (e) => ({
      courseId: e.courseId,
      courseTitle: e.courseTitle,
      courseSlug: e.courseSlug,
      totalSeats: e.total,
      claimedSeats: e.claimed,
    })
  );

  // Build coupon rows with redeemer email
  const couponRows: CouponRow[] = allCoupons.map((coupon) => {
    let redeemedByEmail: string | null = null;
    if (coupon.redeemedByUserId !== null) {
      const user = getUserById(coupon.redeemedByUserId);
      redeemedByEmail = user?.email ?? null;
    }
    const course = getCourseById(coupon.courseId);
    return {
      id: coupon.id,
      code: coupon.code,
      courseId: coupon.courseId,
      courseTitle: course?.title ?? "Unknown Course",
      redeemedByEmail,
      seatState: getSeatState(coupon),
      createdAt: coupon.createdAt,
    };
  });

  const teamPurchases = listTeamPurchasesForBuyer(currentUserId);

  return { courseStats, couponRows, teamPurchases };
}

/** The Team Admin who made a Team Purchase requests a Team Refund. */
export async function action({ request }: Route.ActionArgs) {
  const currentUserId = await getCurrentUserId(request);

  if (!currentUserId) {
    throw data("Select a user from the DevUI panel.", { status: 401 });
  }

  const formData = await request.formData();
  const parsed = parseFormData(formData, teamRefundSchema);

  if (!parsed.success) {
    const firstError = Object.values(parsed.errors)[0] ?? "Invalid request.";
    throw data(firstError, { status: 400 });
  }

  try {
    sendEmail(
      requestRefund(currentUserId, parsed.data.purchaseId, parsed.data.reason)
        .email
    );
  } catch (error) {
    throwRefundErrorAsResponse(error);
  }

  return { ok: true as const };
}

function RequestTeamRefund({
  purchaseId,
  refundAmount,
  seatCount,
  seatPrice,
}: {
  purchaseId: number;
  refundAmount: number;
  seatCount: number;
  seatPrice: number;
}) {
  const fetcher = useFetcher<typeof action>();
  const [isFormOpen, setIsFormOpen] = useState(false);
  const isSubmitting = fetcher.state !== "idle";

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.ok) {
      toast.success("Refund requested.");
    }
  }, [fetcher.state, fetcher.data]);

  const seats = seatCount === 1 ? "unclaimed seat" : "unclaimed seats";

  if (!isFormOpen) {
    return (
      <Button variant="ghost" size="sm" onClick={() => setIsFormOpen(true)}>
        Request a refund
      </Button>
    );
  }

  return (
    <fetcher.Form method="post" className="mt-3 space-y-2">
      <p className="text-xs text-muted-foreground">
        If your request is approved, we will refund {formatPrice(refundAmount)}{" "}
        for {seatCount} {seats} at {formatPrice(seatPrice)} each. Those seats
        can&apos;t be claimed while we review it. Anyone who already claimed a
        seat keeps their access.
      </p>
      <input type="hidden" name="intent" value="request-team-refund" />
      <input type="hidden" name="purchaseId" value={purchaseId} />
      <Textarea
        name="reason"
        rows={3}
        required
        minLength={REFUND_REASON_MIN_LENGTH}
        maxLength={REFUND_REASON_MAX_LENGTH}
        placeholder="What went wrong?"
      />
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={isSubmitting}>
          {isSubmitting ? "Sending..." : "Request a refund"}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setIsFormOpen(false)}
        >
          Never mind
        </Button>
      </div>
    </fetcher.Form>
  );
}

function CopyButton({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);

  function handleCopy() {
    const url = `${window.location.origin}/redeem/${code}`;
    navigator.clipboard.writeText(url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  return (
    <button
      onClick={handleCopy}
      className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-primary hover:bg-primary/10 transition-colors"
      title="Copy redemption link"
    >
      {copied ? (
        <>
          <Check className="size-3" />
          Copied
        </>
      ) : (
        <>
          <Copy className="size-3" />
          Copy link
        </>
      )}
    </button>
  );
}

export default function Team({ loaderData }: Route.ComponentProps) {
  const { courseStats, couponRows, teamPurchases } = loaderData;
  const [courseFilter, setCourseFilter] = useState<number | "all">("all");

  const filteredCoupons =
    courseFilter === "all"
      ? couponRows
      : couponRows.filter((c) => c.courseId === courseFilter);

  return (
    <div className="mx-auto max-w-7xl p-6 lg:p-8">
      <nav className="mb-6 text-sm text-muted-foreground">
        <Link to="/" className="hover:text-foreground">
          Home
        </Link>
        <span className="mx-2">/</span>
        <span className="text-foreground">Team</span>
      </nav>

      <div className="mb-8">
        <h1 className="text-3xl font-bold">Team Management</h1>
        <p className="mt-1 text-muted-foreground">
          Manage your team&apos;s course seats and coupon codes
        </p>
      </div>

      {/* Per-course stats */}
      {courseStats.length > 0 && (
        <div className="mb-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {courseStats.map((stat) => (
            <Card key={stat.courseId}>
              <CardHeader className="pb-2">
                <div className="flex items-center gap-2">
                  <BookOpen className="size-4 text-muted-foreground" />
                  <h3 className="font-semibold truncate">{stat.courseTitle}</h3>
                </div>
              </CardHeader>
              <CardContent>
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-2xl font-bold">
                      {stat.claimedSeats}
                      <span className="text-base font-normal text-muted-foreground">
                        {" "}
                        / {stat.totalSeats}
                      </span>
                    </p>
                    <p className="text-xs text-muted-foreground">
                      seats claimed
                    </p>
                  </div>
                  <Link to={`/courses/${stat.courseSlug}/purchase?mode=team`}>
                    <Button variant="outline" size="sm">
                      Buy more seats
                    </Button>
                  </Link>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Team Purchases: each can get its own Team Refund */}
      {teamPurchases.length > 0 && (
        <div className="mb-8">
          <h2 className="mb-4 text-lg font-semibold">Team Purchases</h2>
          <div className="space-y-3">
            {teamPurchases.map((teamPurchase) => (
              <div key={teamPurchase.purchaseId} className="rounded-md border p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="font-medium">{teamPurchase.courseTitle}</p>
                    <p className="text-sm text-muted-foreground">
                      Bought{" "}
                      {new Date(teamPurchase.purchasedAt).toLocaleDateString()} ·{" "}
                      {teamPurchase.claimedSeats} / {teamPurchase.totalSeats} seats
                      claimed
                    </p>
                  </div>
                  {teamPurchase.refundStatus === RefundStatus.Requested ? (
                    <span className="rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-900/30 dark:text-amber-300">
                      Refund requested
                    </span>
                  ) : teamPurchase.refundStatus === RefundStatus.Approved ? (
                    <span className="rounded-full bg-muted px-2.5 py-0.5 text-xs font-medium text-muted-foreground">
                      Refund approved
                    </span>
                  ) : (
                    teamPurchase.refundOffer && (
                      <RequestTeamRefund
                        purchaseId={teamPurchase.purchaseId}
                        refundAmount={teamPurchase.refundOffer.refundAmount}
                        seatCount={teamPurchase.refundOffer.teamSeats.count}
                        seatPrice={teamPurchase.refundOffer.teamSeats.seatPrice}
                      />
                    )
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Coupon list */}
      <div>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Coupons</h2>
          {courseStats.length > 1 && (
            <select
              value={courseFilter}
              onChange={(e) =>
                setCourseFilter(
                  e.target.value === "all" ? "all" : Number(e.target.value)
                )
              }
              className="rounded-md border border-input bg-background px-3 py-1.5 text-sm"
            >
              <option value="all">All courses</option>
              {courseStats.map((stat) => (
                <option key={stat.courseId} value={stat.courseId}>
                  {stat.courseTitle}
                </option>
              ))}
            </select>
          )}
        </div>

        {filteredCoupons.length === 0 ? (
          <p className="text-sm text-muted-foreground">No coupons yet.</p>
        ) : (
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/50">
                  <th className="px-4 py-3 text-left font-medium">Code</th>
                  <th className="px-4 py-3 text-left font-medium">Course</th>
                  <th className="px-4 py-3 text-left font-medium">Status</th>
                  <th className="px-4 py-3 text-left font-medium">Action</th>
                </tr>
              </thead>
              <tbody>
                {filteredCoupons.map((coupon) => (
                  <tr key={coupon.id} className="border-b last:border-0">
                    <td className="px-4 py-3">
                      <code className="rounded bg-muted px-2 py-0.5 text-xs">
                        {coupon.code}
                      </code>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {coupon.courseTitle}
                    </td>
                    <td className="px-4 py-3">
                      {coupon.seatState === "claimed" ? (
                        <span className="text-muted-foreground">
                          Claimed by {coupon.redeemedByEmail}
                        </span>
                      ) : coupon.seatState === "locked" ? (
                        <span className="inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-900/30 dark:text-amber-300">
                          Locked: refund requested
                        </span>
                      ) : coupon.seatState === "cancelled" ? (
                        <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                          Cancelled: refunded
                        </span>
                      ) : (
                        <span className="inline-flex items-center rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-700 dark:bg-green-900/30 dark:text-green-400">
                          Unclaimed
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {coupon.seatState === "unclaimed" && (
                        <CopyButton code={coupon.code} />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let title = "Something went wrong";
  let message = "An unexpected error occurred.";

  if (isRouteErrorResponse(error)) {
    if (error.status === 401) {
      title = "Sign in required";
      message =
        typeof error.data === "string"
          ? error.data
          : "Please select a user from the DevUI panel.";
    } else if (error.status === 403) {
      title = "No team found";
      message =
        typeof error.data === "string"
          ? error.data
          : "You don't have a team yet.";
    } else {
      title = `Error ${error.status}`;
      message = typeof error.data === "string" ? error.data : error.statusText;
    }
  }

  return (
    <div className="flex min-h-[50vh] items-center justify-center p-6">
      <div className="text-center">
        <AlertTriangle className="mx-auto mb-4 size-12 text-muted-foreground" />
        <h1 className="mb-2 text-2xl font-bold">{title}</h1>
        <p className="mb-6 text-muted-foreground">{message}</p>
        <div className="flex items-center justify-center gap-3">
          <Link to="/">
            <Button>Go Home</Button>
          </Link>
          <Link to="/courses">
            <Button variant="outline">Browse Courses</Button>
          </Link>
        </div>
      </div>
    </div>
  );
}
