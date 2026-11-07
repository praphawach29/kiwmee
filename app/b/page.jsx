import { redirect } from "next/navigation";
import { liffRedirect } from "./liff-state.mjs";

// The LIFF app's endpoint: LINE lands here first, then the customer goes to the shop in the link.
// Set the LIFF endpoint URL to https://<host>/b and share https://liff.line.me/<liffId>/<shop slug>.
export const dynamic = "force-dynamic";

export default async function LiffEntry({ searchParams }) {
  // the rest of the query goes along: LINE's sign-in code in a browser is finished on the shop's page
  redirect(liffRedirect((await searchParams) ?? {}));
}
