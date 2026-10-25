// Small fetch helpers shared by the dashboard pages.

export async function api(method, url, body) {
  const response = await fetch(url, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload?.error?.message || "ระบบขัดข้อง กรุณาลองใหม่");
    error.status = response.status;
    error.code = payload?.error?.code;
    throw error;
  }
  return payload.data;
}

// Supabase Auth's REST API, called from the browser so its rate limits count each owner's own address
export async function supabaseAuth(auth, path, body, accessToken) {
  const response = await fetch(`${auth.url}/auth/v1/${path}`, {
    method: accessToken && path === "user" ? "PUT" : "POST",
    headers: {
      apikey: auth.key,
      "content-type": "application/json",
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {})
    },
    body: JSON.stringify(body)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(authMessage(payload));
  return payload;
}

function authMessage(payload) {
  const code = payload?.error_code || payload?.error;
  const known = {
    invalid_credentials: "อีเมลหรือรหัสผ่านไม่ถูกต้อง",
    invalid_grant: "อีเมลหรือรหัสผ่านไม่ถูกต้อง",
    email_not_confirmed: "ยังไม่ได้ยืนยันอีเมล กรุณากดลิงก์ในอีเมลก่อน",
    user_already_exists: "อีเมลนี้สมัครไว้แล้ว ลองเข้าสู่ระบบ",
    weak_password: "รหัสผ่านสั้นหรือเดาง่ายเกินไป",
    over_email_send_rate_limit: "ส่งอีเมลถี่เกินไป กรุณารอสักครู่",
    over_request_rate_limit: "ลองหลายครั้งเกินไป กรุณารอสักครู่",
    signup_disabled: "ปิดรับสมัครอยู่ ติดต่อผู้ดูแลระบบ",
    same_password: "รหัสผ่านใหม่ต้องไม่ซ้ำกับรหัสเดิม"
  };
  return known[code] || payload?.msg || payload?.error_description || payload?.message || "เข้าสู่ระบบไม่สำเร็จ";
}
