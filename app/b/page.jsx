import { redirect } from "next/navigation";
import { liffTarget } from "./liff-state.mjs";

// The LIFF app's endpoint: LINE lands here first, then the customer goes to the shop in the link.
// Set the LIFF endpoint URL to https://<host>/b and share https://liff.line.me/<liffId>/<shop slug>.
export const dynamic = "force-dynamic";

export default async function LiffEntry({ searchParams }) {
  const params = await searchParams;
  const state = Array.isArray(params?.["liff.state"]) ? params["liff.state"][0] : params?.["liff.state"];
  redirect(liffTarget(state) ?? "/");
}
