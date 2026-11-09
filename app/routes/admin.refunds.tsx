import { useEffect } from "react";
import { data, isRouteErrorResponse, Link, useFetcher } from "react-router";
import { toast } from "sonner";
import { z } from "zod";
import type { Route } from "./+types/admin.refunds";
import { requireAdmin } from "~/lib/access.server";
import { sendEmail } from "~/lib/email.server";
import { parseFormData } from "~/lib/validation";
import { formatPrice } from "~/lib/utils";
import {
  listRequestedRefundRequests,
  resolveRefundRequest,
  throwRefundErrorAsResponse,
} from "~/lib/refunds.server";
import { Card, CardContent, CardHeader } from "~/components/ui/card";
import { Button } from "~/components/ui/button";
import { AlertTriangle, ReceiptText } from "lucide-react";

const resolveSchema = z.object({
  refundRequestId: z.coerce.number().int(),
  decision: z.enum(["approve", "decline"]),
});

export function meta() {
  return [{ title: "Refund Requests — Cadence" }];
}

export async function loader({ request }: Route.LoaderArgs) {
  await requireAdmin(request);
  return { refundRequests: listRequestedRefundRequests() };
}

export async function action({ request }: Route.ActionArgs) {
  const adminUserId = await requireAdmin(request);

  const formData = await request.formData();
  const parsed = parseFormData(formData, resolveSchema);

  if (!parsed.success) {
    throw data("Invalid refund decision.", { status: 400 });
  }

  const { refundRequestId, decision } = parsed.data;

  try {
    sendEmail(resolveRefundRequest(refundRequestId, decision, adminUserId).email);
  } catch (error) {
    throwRefundErrorAsResponse(error);
  }

  return { decision };
}

export default function AdminRefunds({ loaderData }: Route.ComponentProps) {
  const { refundRequests } = loaderData;

  return (
    <div className="mx-auto max-w-4xl p-6 lg:p-8">
      <div className="mb-8">
        <h1 className="text-3xl font-bold">Refund Requests</h1>
        <p className="mt-1 text-muted-foreground">
          Approving a Personal Purchase refunds what the Student paid and ends
          their access. Approving a Team Refund refunds its unclaimed seats and
          cancels them, and nobody loses access. Declining refunds nothing.
        </p>
      </div>

      {refundRequests.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <ReceiptText className="mx-auto mb-4 size-12 text-muted-foreground/50" />
            <p className="text-muted-foreground">
              No refund requests are waiting for review.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {refundRequests.map((refundRequest) => (
            <RefundRequestCard
              key={refundRequest.id}
              refundRequest={refundRequest}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function RefundRequestCard({
  refundRequest,
}: {
  refundRequest: ReturnType<typeof listRequestedRefundRequests>[number];
}) {
  const fetcher = useFetcher<typeof action>();
  const isSubmitting = fetcher.state !== "idle";

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data) {
      toast.success(
        fetcher.data.decision === "approve"
          ? "Refund approved."
          : "Refund declined."
      );
    }
  }, [fetcher.state, fetcher.data]);

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-4">
          <div>
            <Link
              to={`/courses/${refundRequest.courseSlug}`}
              className="font-medium hover:underline"
            >
              {refundRequest.courseTitle}
            </Link>
            <p className="text-sm text-muted-foreground">
              {refundRequest.buyerName} · {refundRequest.buyerEmail}
            </p>
          </div>
          <span className="shrink-0 rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-900/30 dark:text-amber-300">
            Refund requested
          </span>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">
          Refund Amount {formatPrice(refundRequest.refundAmount)}
          {refundRequest.teamSeats &&
            ` (Team Refund: ${refundRequest.teamSeats.count} unclaimed ${
              refundRequest.teamSeats.count === 1 ? "seat" : "seats"
            } at ${formatPrice(refundRequest.teamSeats.seatPrice)} each)`}{" "}
          · bought{" "}
          {new Date(refundRequest.purchasedAt).toLocaleDateString()} · requested{" "}
          {new Date(refundRequest.requestedAt).toLocaleDateString()}
        </p>
        <p className="text-sm">{refundRequest.reason}</p>
        <fetcher.Form method="post" className="flex gap-2">
          <input
            type="hidden"
            name="refundRequestId"
            value={refundRequest.id}
          />
          <Button
            type="submit"
            name="decision"
            value="approve"
            size="sm"
            disabled={isSubmitting}
          >
            Approve
          </Button>
          <Button
            type="submit"
            name="decision"
            value="decline"
            size="sm"
            variant="outline"
            disabled={isSubmitting}
          >
            Decline
          </Button>
        </fetcher.Form>
      </CardContent>
    </Card>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let title = "Something went wrong";
  let message = "An unexpected error occurred while loading refund requests.";

  if (isRouteErrorResponse(error)) {
    title =
      error.status === 401
        ? "Sign in required"
        : error.status === 403
          ? "Access denied"
          : `Error ${error.status}`;
    message = typeof error.data === "string" ? error.data : error.statusText;
  }

  return (
    <div className="flex min-h-[50vh] items-center justify-center p-6">
      <div className="text-center">
        <AlertTriangle className="mx-auto mb-4 size-12 text-muted-foreground" />
        <h1 className="mb-2 text-2xl font-bold">{title}</h1>
        <p className="mb-6 text-muted-foreground">{message}</p>
        <Link to="/">
          <Button>Go Home</Button>
        </Link>
      </div>
    </div>
  );
}
