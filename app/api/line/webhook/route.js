// ที่เดิมของ webhook บอท LINE v1 (โค้ด v1 ถูกลบใน PR ที่อ้าง docs/V1_RETIREMENT.md).
// channel ของบอทเดิมชี้ไป linebooking-amber.vercel.app และ "Use webhook" ปิดอยู่ —
// เก็บ route นี้ไว้เป็นป้ายบอกทาง: ถ้ามีใครยังยิงเข้ามา จะเห็นใน Railway logs ทันที (410 Gone)
const runtime = "nodejs";

function gone() {
  console.error("[v1-webhook] a request reached the retired v1 webhook — check docs/V1_RETIREMENT.md");
  return Response.json(
    { error: { code: "GONE", message: "v1 webhook retired — LINE BOT this endpoint served is no longer here" } },
    { status: 410, headers: { "cache-control": "no-store" } }
  );
}

async function POST() {
  return gone();
}

async function GET() {
  return gone();
}

module.exports = { POST, GET, runtime };
