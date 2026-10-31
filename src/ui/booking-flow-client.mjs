export const STEPS = ["service", "staff", "time", "customer", "review", "success"];

export function canContinue(step, state) {
  if (step === "service") {
    return Boolean(state.service);
  }
  if (step === "staff") {
    return state.staffChoice === "any" || Boolean(state.staff);
  }
  if (step === "time") {
    return Boolean(state.slot);
  }
  if (step === "customer") {
    return Boolean(state.customer?.name?.trim() && state.customer?.phone?.trim());
  }
  if (step === "review") {
    return Boolean(state.service && state.slot && state.customer?.name?.trim() && state.customer?.phone?.trim());
  }
  return false;
}

export function conflictMessage(error) {
  if (error?.code === "CONFLICT") {
    return "ช่วงเวลานี้เพิ่งถูกจอง กรุณาเลือกเวลาใหม่";
  }
  return error?.message || "ระบบยังทำรายการไม่ได้ กรุณาลองใหม่";
}

export function selectedStaffName(state, staffList) {
  const staffId = state.slot?.staff_id ?? state.staff?.id;
  return staffList.find((staff) => staff.id === staffId)?.name ?? "ใครก็ได้";
}

export function formatMoney(value) {
  if (value === null || value === undefined || value === "") {
    return "-";
  }
  return new Intl.NumberFormat("th-TH", {
    style: "currency",
    currency: "THB",
    maximumFractionDigits: 0
  }).format(Number(value));
}

export function formatDateTime(value) {
  if (!value) {
    return "-";
  }
  return new Intl.DateTimeFormat("th-TH", {
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Bangkok"
  }).format(new Date(value));
}

export function getTodayBangkok() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok" }).format(new Date());
}
