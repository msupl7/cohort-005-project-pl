import { data, redirect } from "react-router";
import { z } from "zod";
import type { Route } from "./+types/courses.$slug.refund";
import { requireUserId } from "~/lib/access.server";
import { sendEmail } from "~/lib/email.server";
import { db } from "~/db";
import { courses } from "~/db/schema";
import { eq } from "drizzle-orm";
import { parseFormData, parseParams } from "~/lib/validation";
import { refundReasonSchema } from "~/lib/refunds";
import {
  RefundRequestError,
  getRefundEligibility,
  requestRefund,
  throwRefundErrorAsResponse,
} from "~/lib/refunds.server";

const refundParamsSchema = z.object({
  slug: z.string().min(1),
});

const refundActionSchema = z.object({
  reason: refundReasonSchema,
});

/** A Student requests a Refund for their Personal Purchase of a course. */
export async function action({ params, request }: Route.ActionArgs) {
  const currentUserId = await requireUserId(request);

  const { slug } = parseParams(params, refundParamsSchema);
  const course = db.select().from(courses).where(eq(courses.slug, slug)).get();

  if (!course) {
    throw data("Course not found", { status: 404 });
  }

  const formData = await request.formData();
  const parsed = parseFormData(formData, refundActionSchema);

  if (!parsed.success) {
    const firstError = Object.values(parsed.errors)[0] ?? "Invalid reason.";
    throw data(firstError, { status: 400 });
  }

  try {
    const eligibility = getRefundEligibility(currentUserId, course.id);
    if (!eligibility.eligible) {
      throw new RefundRequestError(eligibility.reason);
    }
    sendEmail(
      requestRefund(currentUserId, eligibility.purchase.id, parsed.data.reason)
        .email
    );
  } catch (error) {
    throwRefundErrorAsResponse(error);
  }

  return redirect("/settings");
}
