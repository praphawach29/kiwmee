const { adminRoute } = require("../../../../../src/v2/admin-auth");
const { revenueReport, revenueCsv } = require("../../../../../src/v2/platform-revenue");

// ดาวน์โหลดรายงานรายได้เป็น CSV (เปิดใน Excel ได้ มี BOM ภาษาไทย)
async function GET(request) {
  return adminRoute(request, async (user) => {
    const report = await revenueReport(user.id);
    const csv = revenueCsv(report);
    return new Response(csv, {
      status: 200,
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="kiwmee-revenue-${new Date().toISOString().slice(0, 10)}.csv"`,
        "cache-control": "no-store"
      }
    });
  });
}

module.exports = { GET };
