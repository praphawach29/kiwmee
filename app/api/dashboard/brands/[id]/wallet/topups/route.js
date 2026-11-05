const { adminRoute } = require("../../../../../../../src/v2/admin-auth");
const { getParams, json } = require("../../../../../../../src/http");
const { sameOrigin } = require("../../../../../../../src/security/limits");
const { badRequest } = require("../../../../../../../src/errors");
const { submitTopup } = require("../../../../../../../src/v2/wallet");

const ALLOWED = ["image/jpeg", "image/png", "image/webp"];
const runtime = "nodejs";

// เติมเงิน: ส่งรูปสลิปมาเป็น binary (POST .../wallet/topups?amount=1000)
// สลิปผ่านการตรวจ = เติมเข้าอัตโนมัติ · ไม่ผ่าน = เก็บไว้ให้ผู้ดูแลตรวจ
async function POST(request, context) {
  return adminRoute(request, async (user) => {
    sameOrigin(request);
    const params = await getParams(context);
    const amount = Number(new URL(request.url).searchParams.get("amount"));
    const mime = (request.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    if (!ALLOWED.includes(mime)) throw badRequest("แนบรูปสลิปเป็น JPEG, PNG หรือ WebP");
    const body = Buffer.from(await request.arrayBuffer());
    if (!body.length) throw badRequest("ไม่พบรูปสลิป");
    const result = await submitTopup(params.id, user.id, { amount, image: body, mime });
    return json(result, 201);
  });
}

module.exports = { POST, runtime };
