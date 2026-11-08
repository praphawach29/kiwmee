import * as platformSettings from "../../../../src/v2/platform-settings";
import * as v2db from "../../../../src/v2/db";
import OwnerLineClient from "./owner-line-client.jsx";
import "./owner-line.css";

export const dynamic = "force-dynamic";
export const metadata = { title: "เชื่อม LINE กับ Kiwmee", robots: { index: false } };

// B8: a shop owner opens the link from the dashboard in LINE → LINE says who they are → Kiwmee's
// notices about their plan go to this LINE account (src/v2/owner-notices.js finishLink)
export default async function OwnerLinePage({ params }) {
  const { code } = await params;
  const liffId = await platformSettings.getSetting(v2db.getBookingPool(), "line.liff_id");
  return <OwnerLineClient code={String(code ?? "")} liffId={liffId || null} />;
}
