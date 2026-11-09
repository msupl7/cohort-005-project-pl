import type { Email } from "~/lib/refunds";

/**
 * Sends an email. There is no mail transport wired up yet, so the message is
 * written to the server log instead.
 */
export function sendEmail(email: Email): void {
  console.log(`[email] to=${email.to} subject=${email.subject}\n${email.body}`);
}
