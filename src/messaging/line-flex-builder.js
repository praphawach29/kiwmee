// Salon Booking OS v1 - LINE Flex Message Builder
// Generates rich, interactive Flex Message Carousels and Bubble Cards for booking flow
// Unified with Brand Palette & Production Visual Identity

const BRAND = {
  PRIMARY_GREEN: "#12B981",
  DARK: "#101827",
  SURFACE: "#F4F5F7",
  TEXT_PRIMARY: "#111827",
  TEXT_SECONDARY: "#6B7280",
  BORDER: "#E5E7EB",
  MUTED: "#9CA3AF",
  WHITE: "#FFFFFF",
  LIGHT_GREEN_BG: "#ECFDF5",
  LIGHT_GREEN_TEXT: "#065F46"
};

const SERVICE_IMAGES = {
  detox: "https://images.unsplash.com/photo-1519699047748-de8e457a634e?auto=format&fit=crop&w=800&q=80",
  haircut: "https://images.unsplash.com/photo-1560869713-7d0a29430803?auto=format&fit=crop&w=800&q=80",
  color: "https://images.unsplash.com/photo-1522337360788-8b13dee7a37e?auto=format&fit=crop&w=800&q=80",
  spa: "https://images.unsplash.com/photo-1527799820374-dcf8d9d4a388?auto=format&fit=crop&w=800&q=80",
  wash: "https://images.unsplash.com/photo-1521590832167-7bcbfaa6381f?auto=format&fit=crop&w=800&q=80",
  default: "https://images.unsplash.com/photo-1562322140-8baeececf3df?auto=format&fit=crop&w=800&q=80"
};

const STAFF_IMAGES = {
  // Luxury salon styling chairs and mirrors for "Anyone / First Available"
  any: "https://images.unsplash.com/photo-1560066984-138dadb4c035?auto=format&fit=crop&w=800&q=80",
  // Stylists in salon theme
  ann: "https://images.unsplash.com/photo-1595476108010-b4d1f102b1b1?auto=format&fit=crop&w=500&q=80",
  meen: "https://images.unsplash.com/photo-1580618672591-eb180b1a973f?auto=format&fit=crop&w=500&q=80",
  karn: "https://images.unsplash.com/photo-1622286342621-4bd786c2447c?auto=format&fit=crop&w=500&q=80",
  default: "https://images.unsplash.com/photo-1562322140-8baeececf3df?auto=format&fit=crop&w=500&q=80"
};

function getServiceImage(service) {
  if (service?.image_url) return service.image_url;
  const text = `${service?.name ?? ""} ${service?.description ?? ""}`.toLowerCase();
  if (/ดีท็อกซ์|scalp|detox/i.test(text)) return SERVICE_IMAGES.detox;
  if (/ตัดผม|haircut|ทรง/i.test(text)) return SERVICE_IMAGES.haircut;
  if (/สี|color|gloss|ไฮไลต์/i.test(text)) return SERVICE_IMAGES.color;
  if (/สปา|spa|ฟื้นฟู|repair|treatment/i.test(text)) return SERVICE_IMAGES.spa;
  if (/สระ|ไดร์|wash|blow/i.test(text)) return SERVICE_IMAGES.wash;
  return SERVICE_IMAGES.default;
}

function getServiceCategory(service) {
  const text = `${service?.name ?? ""} ${service?.description ?? ""}`.toLowerCase();
  if (/ตัดผม|haircut|สระไดร์|wash|blow|ทรง/i.test(text)) return "ตัดและจัดทรง";
  if (/สี|color|gloss|ไฮไลต์|ฟอก/i.test(text)) return "ทำสีและเคมี";
  if (/สปา|spa|ดีท็อกซ์|detox|ฟื้นฟู|treatment|บำรุง/i.test(text)) return "สปาและทรีตเมนต์";
  return "บริการทั่วไป";
}

function getStaffImage(staff) {
  if (staff?.image_url) return staff.image_url;
  if (!staff || staff.id === "ANY_STAFF" || staff.name === "ใครก็ได้") return STAFF_IMAGES.any;
  const name = (staff.name || "").toLowerCase();
  if (/แอน|ann/i.test(name)) return STAFF_IMAGES.ann;
  if (/มีน|meen|min/i.test(name)) return STAFF_IMAGES.meen;
  if (/กานต์|karn|kan/i.test(name)) return STAFF_IMAGES.karn;
  return STAFF_IMAGES.default;
}

function formatPrice(price) {
  if (price == null) return "สอบถามร้าน";
  const num = Number(price);
  return Number.isFinite(num) ? `฿${num.toLocaleString("th-TH")}` : `${price} บาท`;
}

function formatDateOnly(value) {
  return value ? new Intl.DateTimeFormat("th-TH", { timeZone: "Asia/Bangkok", dateStyle: "medium" }).format(new Date(value)) : "";
}

function formatTime(value) {
  return value ? new Intl.DateTimeFormat("th-TH", { timeZone: "Asia/Bangkok", hour: "2-digit", minute: "2-digit" }).format(new Date(value)) : "";
}

function truncate(text, max = 20) {
  if (text == null) return "";
  const str = String(text);
  return str.length <= max ? str : str.slice(0, max - 1) + "…";
}

/**
 * 1. Build Service Carousel Flex Message
 */
function buildServiceCarousel(services, { selectedCategory = null, total = null } = {}) {
  const bubbles = services.slice(0, 10).map((s) => {
    const imageUrl = getServiceImage(s);
    const category = getServiceCategory(s);
    const priceText = formatPrice(s.price);
    const durationText = `${s.duration_minutes || 60} นาที`;

    return {
      type: "bubble",
      size: "kilo",
      hero: {
        type: "image",
        url: imageUrl,
        size: "full",
        aspectRatio: "20:13",
        aspectMode: "cover"
      },
      body: {
        type: "box",
        layout: "vertical",
        paddingAll: "lg",
        contents: [
          {
            type: "text",
            text: category,
            weight: "bold",
            color: BRAND.PRIMARY_GREEN,
            size: "xxs"
          },
          {
            type: "text",
            text: s.name,
            weight: "bold",
            size: "md",
            color: BRAND.TEXT_PRIMARY,
            wrap: true,
            margin: "xs",
            maxLines: 2
          },
          {
            type: "text",
            text: s.description || "บริการมาตรฐานคุณภาพระดับพรีเมียม",
            size: "xs",
            color: BRAND.TEXT_SECONDARY,
            wrap: true,
            margin: "sm",
            maxLines: 2
          },
          {
            type: "box",
            layout: "baseline",
            margin: "md",
            contents: [
              {
                type: "text",
                text: priceText,
                weight: "bold",
                size: "lg",
                color: BRAND.TEXT_PRIMARY,
                flex: 0
              },
              {
                type: "text",
                text: ` · ${durationText}`,
                size: "xs",
                color: BRAND.MUTED,
                margin: "sm"
              }
            ]
          }
        ]
      },
      footer: {
        type: "box",
        layout: "vertical",
        paddingAll: "md",
        contents: [
          {
            type: "button",
            style: "primary",
            color: BRAND.PRIMARY_GREEN,
            height: "sm",
            action: {
              type: "postback",
              label: "เลือกบริการนี้",
              data: `action=service&service_id=${s.id}`,
              displayText: `เลือกบริการ: ${truncate(s.name, 20)}`
            }
          }
        ]
      }
    };
  });

  // If there are more than 10 services, add a "ดูบริการเพิ่มเติม" card
  if (total && total > 10 && services.length < total) {
    bubbles.push({
      type: "bubble",
      size: "kilo",
      body: {
        type: "box",
        layout: "vertical",
        justifyContent: "center",
        alignItems: "center",
        paddingAll: "xl",
        contents: [
          {
            type: "text",
            text: "ยังมีบริการอื่นอีก",
            weight: "bold",
            size: "md",
            color: BRAND.TEXT_PRIMARY
          },
          {
            type: "text",
            text: `แสดง 10 จากทั้งหมด ${total} รายการ`,
            size: "xs",
            color: BRAND.TEXT_SECONDARY,
            margin: "sm"
          }
        ]
      },
      footer: {
        type: "box",
        layout: "vertical",
        paddingAll: "md",
        contents: [
          {
            type: "button",
            style: "secondary",
            height: "sm",
            action: {
              type: "postback",
              label: "ดูบริการเพิ่มเติม",
              data: `action=more&stage=service&offset=10`,
              displayText: "ดูบริการเพิ่มเติม"
            }
          }
        ]
      }
    });
  }

  return {
    type: "flex",
    altText: "เลือกบริการที่ต้องการค่ะ",
    contents: {
      type: "carousel",
      contents: bubbles
    }
  };
}

/**
 * 2. Build Category Selection Bubble Card (when services > 10 or category request)
 */
function buildCategorySelectionBubble(categories = ["ตัดและจัดทรง", "ทำสีและเคมี", "สปาและทรีตเมนต์", "บริการทั้งหมด"]) {
  const categoryButtons = categories.map((cat) => ({
    type: "button",
    style: "secondary",
    margin: "sm",
    height: "sm",
    action: {
      type: "postback",
      label: truncate(cat, 20),
      data: `action=category&cat=${encodeURIComponent(cat)}`,
      displayText: `หมวดหมู่: ${cat}`
    }
  }));

  return {
    type: "flex",
    altText: "กรุณาเลือกหมวดหมู่บริการค่ะ",
    contents: {
      type: "bubble",
      size: "mega",
      header: {
        type: "box",
        layout: "vertical",
        backgroundColor: BRAND.DARK,
        paddingAll: "lg",
        contents: [
          {
            type: "text",
            text: "หมวดหมู่บริการ",
            weight: "bold",
            color: BRAND.WHITE,
            size: "lg"
          },
          {
            type: "text",
            text: "เลือกหมวดที่สนใจเพื่อดูรายการบริการและภาพตัวอย่างค่ะ",
            color: BRAND.MUTED,
            size: "xs",
            margin: "xs"
          }
        ]
      },
      body: {
        type: "box",
        layout: "vertical",
        paddingAll: "lg",
        contents: categoryButtons
      }
    }
  };
}

/**
 * 3. Build Staff Carousel Flex Message
 */
function buildStaffCarousel(staffList, service = null) {
  const bubbles = [];

  // 1. "ใครก็ได้" Card (Any Stylist / First Available Workstation)
  bubbles.push({
    type: "bubble",
    size: "kilo",
    hero: {
      type: "image",
      url: STAFF_IMAGES.any,
      size: "full",
      aspectRatio: "20:13",
      aspectMode: "cover"
    },
    body: {
      type: "box",
      layout: "vertical",
      paddingAll: "lg",
      contents: [
        {
          type: "text",
          text: "คิวเร็วที่สุด",
          weight: "bold",
          color: BRAND.PRIMARY_GREEN,
          size: "xxs"
        },
        {
          type: "text",
          text: "ใครก็ได้ (ช่างที่ว่าง)",
          weight: "bold",
          size: "md",
          color: BRAND.TEXT_PRIMARY,
          margin: "xs"
        },
        {
          type: "text",
          text: "ระบบจะจัดสรรช่างที่มีคิวว่างตรงกับเวลาที่ท่านสะดวกที่สุด",
          size: "xs",
          color: BRAND.TEXT_SECONDARY,
          wrap: true,
          margin: "sm"
        }
      ]
    },
    footer: {
      type: "box",
      layout: "vertical",
      paddingAll: "md",
      contents: [
        {
          type: "button",
          style: "primary",
          color: BRAND.PRIMARY_GREEN,
          height: "sm",
          action: {
            type: "postback",
            label: "เลือกใครก็ได้",
            data: "action=staff&staff_id=ANY_STAFF",
            displayText: "เลือกช่าง: ใครก็ได้"
          }
        }
      ]
    }
  });

  // 2. Individual Staff Cards
  for (const st of staffList.slice(0, 9)) {
    const imageUrl = getStaffImage(st);
    // Parse role/title if in parenthesis, e.g. "ช่างแอน (Senior Stylist)"
    const match = (st.name || "").match(/^(.+?)\s*\((.*?)\)$/);
    const mainName = match ? match[1].trim() : st.name;
    const role = match ? match[2].trim() : "Stylist";

    bubbles.push({
      type: "bubble",
      size: "kilo",
      hero: {
        type: "image",
        url: imageUrl,
        size: "full",
        aspectRatio: "20:13",
        aspectMode: "cover"
      },
      body: {
        type: "box",
        layout: "vertical",
        paddingAll: "lg",
        contents: [
          {
            type: "text",
            text: role,
            weight: "bold",
            color: BRAND.PRIMARY_GREEN,
            size: "xxs"
          },
          {
            type: "text",
            text: mainName,
            weight: "bold",
            size: "md",
            color: BRAND.TEXT_PRIMARY,
            margin: "xs"
          },
          {
            type: "text",
            text: `ผู้เชี่ยวชาญประจำร้าน ดูแลบริการ ${service?.name ? truncate(service.name, 15) : "อย่างมืออาชีพ"}`,
            size: "xs",
            color: BRAND.TEXT_SECONDARY,
            wrap: true,
            margin: "sm"
          }
        ]
      },
      footer: {
        type: "box",
        layout: "vertical",
        paddingAll: "md",
        contents: [
          {
            type: "button",
            style: "primary",
            color: BRAND.PRIMARY_GREEN,
            height: "sm",
            action: {
              type: "postback",
              label: "เลือกช่างนี้",
              data: `action=staff&staff_id=${st.id}`,
              displayText: `เลือกช่าง: ${truncate(st.name, 20)}`
            }
          }
        ]
      }
    });
  }

  return {
    type: "flex",
    altText: "เลือกช่างที่ต้องการค่ะ",
    contents: {
      type: "carousel",
      contents: bubbles
    }
  };
}

/**
 * 4. Build Date Selection Bubble Card
 */
function buildDateSelectionBubble({ service, staff, today, tomorrow, maxDate }) {
  return {
    type: "flex",
    altText: "เลือกวันที่รับบริการค่ะ",
    contents: {
      type: "bubble",
      size: "mega",
      header: {
        type: "box",
        layout: "vertical",
        backgroundColor: BRAND.DARK,
        paddingAll: "lg",
        contents: [
          {
            type: "text",
            text: "เลือกวันที่รับบริการ",
            weight: "bold",
            color: BRAND.WHITE,
            size: "md"
          },
          {
            type: "text",
            text: `${service?.name ?? "บริการ"} · ช่าง: ${staff?.name ?? "ใครก็ได้"}`,
            color: BRAND.MUTED,
            size: "xs",
            margin: "xs",
            wrap: true
          }
        ]
      },
      body: {
        type: "box",
        layout: "vertical",
        paddingAll: "lg",
        contents: [
          {
            type: "button",
            style: "primary",
            color: BRAND.PRIMARY_GREEN,
            margin: "sm",
            height: "sm",
            action: {
              type: "postback",
              label: "วันนี้",
              data: `action=date&date=${today}`,
              displayText: "เลือกวัน: วันนี้"
            }
          },
          {
            type: "button",
            style: "primary",
            color: BRAND.PRIMARY_GREEN,
            margin: "sm",
            height: "sm",
            action: {
              type: "postback",
              label: "พรุ่งนี้",
              data: `action=date&date=${tomorrow}`,
              displayText: "เลือกวัน: พรุ่งนี้"
            }
          },
          {
            type: "button",
            style: "secondary",
            margin: "sm",
            height: "sm",
            action: {
              type: "datetimepicker",
              label: "เลือกวันที่อื่น (ปฏิทิน)",
              data: "action=date_picker",
              mode: "date",
              initial: today,
              min: today,
              max: maxDate
            }
          }
        ]
      }
    }
  };
}

/**
 * 5. Build Time Slot Selection Bubble Card
 */
function buildSlotSelectionBubble({ service, staff, date, slots = [] }) {
  const displaySlots = slots.slice(0, 9);
  const formattedDate = formatDateOnly(date);

  const slotButtons = displaySlots.map((slot) => {
    const time = formatTime(slot.start_at);
    return {
      type: "button",
      style: "secondary",
      margin: "xs",
      height: "sm",
      action: {
        type: "postback",
        label: time,
        data: `action=slot&staff_id=${slot.staff_id}&start_at=${encodeURIComponent(slot.start_at)}`,
        displayText: `เลือกเวลา: ${time} น.`
      }
    };
  });

  return {
    type: "flex",
    altText: "เลือกรอบเวลาที่ต้องการค่ะ",
    contents: {
      type: "bubble",
      size: "mega",
      header: {
        type: "box",
        layout: "vertical",
        backgroundColor: BRAND.DARK,
        paddingAll: "lg",
        contents: [
          {
            type: "text",
            text: "เลือกรอบเวลาที่ต้องการ",
            weight: "bold",
            color: BRAND.WHITE,
            size: "md"
          },
          {
            type: "text",
            text: `วันที่ ${formattedDate} · ${service?.name ?? ""}`,
            color: BRAND.MUTED,
            size: "xs",
            margin: "xs",
            wrap: true
          }
        ]
      },
      body: {
        type: "box",
        layout: "vertical",
        paddingAll: "md",
        contents: slotButtons.length > 0 ? slotButtons : [
          {
            type: "text",
            text: "ไม่มีรอบเวลาว่างในวันที่เลือก กรุณาเลือกวันอื่นค่ะ",
            color: "#EF4444",
            size: "sm",
            wrap: true
          }
        ]
      }
    }
  };
}

/**
 * 6. Build Contact Prompt Bubble Card
 */
function buildContactPromptBubble({ service, staff, date, slot }) {
  const time = formatTime(slot?.start_at);
  const formattedDate = formatDateOnly(date || slot?.start_at);

  return {
    type: "flex",
    altText: "ขอชื่อและเบอร์โทรศัพท์สำหรับติดต่อค่ะ",
    contents: {
      type: "bubble",
      size: "mega",
      header: {
        type: "box",
        layout: "vertical",
        backgroundColor: BRAND.DARK,
        paddingAll: "lg",
        contents: [
          {
            type: "text",
            text: "ข้อมูลติดต่อสำหรับนัดหมาย",
            weight: "bold",
            color: BRAND.WHITE,
            size: "md"
          },
          {
            type: "text",
            text: `${service?.name ?? "บริการ"} (${formattedDate} ${time} น.)`,
            color: BRAND.MUTED,
            size: "xs",
            margin: "xs"
          }
        ]
      },
      body: {
        type: "box",
        layout: "vertical",
        paddingAll: "lg",
        contents: [
          {
            type: "text",
            text: "กรุณาพิมพ์ ชื่อ และ เบอร์โทรศัพท์",
            weight: "bold",
            size: "sm",
            color: BRAND.TEXT_PRIMARY
          },
          {
            type: "text",
            text: "เพื่อใช้ยืนยันการนัดหมายและรับข้อความแจ้งเตือนค่ะ",
            size: "xs",
            color: BRAND.TEXT_SECONDARY,
            margin: "xs"
          },
          {
            type: "box",
            layout: "vertical",
            backgroundColor: BRAND.SURFACE,
            cornerRadius: "md",
            paddingAll: "md",
            margin: "md",
            contents: [
              {
                type: "text",
                text: "ตัวอย่าง: มาลี 0812345678",
                size: "sm",
                color: BRAND.TEXT_PRIMARY
              }
            ]
          }
        ]
      }
    }
  };
}

/**
 * 7. Build Review Ticket Bubble Card
 */
function buildReviewTicketBubble(review) {
  const price = review?.service?.price ? formatPrice(review.service.price) : "สอบถามร้าน";
  const duration = `${review?.service?.duration_minutes ?? 60} นาที`;
  const dateText = formatDateOnly(review?.slot?.start_at);
  const timeText = `${formatTime(review?.slot?.start_at)} น.`;

  return {
    type: "flex",
    altText: "กรุณาตรวจสอบรายละเอียดและกดยืนยันการจองค่ะ",
    contents: {
      type: "bubble",
      size: "mega",
      header: {
        type: "box",
        layout: "vertical",
        backgroundColor: BRAND.DARK,
        paddingAll: "lg",
        contents: [
          {
            type: "text",
            text: "SALON BOOKING",
            size: "xxs",
            color: BRAND.MUTED,
            weight: "bold"
          },
          {
            type: "text",
            text: "สรุปรายละเอียดนัดหมาย",
            weight: "bold",
            color: BRAND.WHITE,
            size: "lg",
            margin: "xs"
          }
        ]
      },
      body: {
        type: "box",
        layout: "vertical",
        paddingAll: "lg",
        contents: [
          // Service
          {
            type: "box",
            layout: "horizontal",
            contents: [
              { type: "text", text: "บริการ", size: "sm", color: BRAND.TEXT_SECONDARY, flex: 2 },
              { type: "text", text: review?.service?.name ?? "-", size: "sm", weight: "bold", color: BRAND.TEXT_PRIMARY, flex: 5, wrap: true }
            ]
          },
          // Stylist
          {
            type: "box",
            layout: "horizontal",
            margin: "md",
            contents: [
              { type: "text", text: "ช่าง", size: "sm", color: BRAND.TEXT_SECONDARY, flex: 2 },
              { type: "text", text: review?.staff?.name ?? "ใครก็ได้", size: "sm", weight: "bold", color: BRAND.TEXT_PRIMARY, flex: 5 }
            ]
          },
          // Date & Time
          {
            type: "box",
            layout: "horizontal",
            margin: "md",
            contents: [
              { type: "text", text: "วันและเวลา", size: "sm", color: BRAND.TEXT_SECONDARY, flex: 2 },
              { type: "text", text: `${dateText} (${timeText})`, size: "sm", weight: "bold", color: BRAND.TEXT_PRIMARY, flex: 5 }
            ]
          },
          // Duration
          {
            type: "box",
            layout: "horizontal",
            margin: "md",
            contents: [
              { type: "text", text: "ระยะเวลา", size: "sm", color: BRAND.TEXT_SECONDARY, flex: 2 },
              { type: "text", text: duration, size: "sm", color: BRAND.TEXT_PRIMARY, flex: 5 }
            ]
          },
          // Price
          {
            type: "box",
            layout: "horizontal",
            margin: "md",
            contents: [
              { type: "text", text: "ยอดรวม", size: "sm", color: BRAND.TEXT_SECONDARY, flex: 2 },
              { type: "text", text: price, size: "md", weight: "bold", color: BRAND.PRIMARY_GREEN, flex: 5 }
            ]
          },
          {
            type: "separator",
            margin: "lg"
          },
          // Customer info
          {
            type: "box",
            layout: "horizontal",
            margin: "md",
            contents: [
              { type: "text", text: "ผู้จอง", size: "xs", color: BRAND.TEXT_SECONDARY, flex: 2 },
              { type: "text", text: `${review?.customer_name ?? ""} (ลงท้าย ${review?.phone_last4 ?? ""})`, size: "xs", color: BRAND.TEXT_SECONDARY, flex: 5 }
            ]
          }
        ]
      },
      footer: {
        type: "box",
        layout: "vertical",
        spacing: "sm",
        paddingAll: "lg",
        contents: [
          {
            type: "button",
            style: "primary",
            color: BRAND.PRIMARY_GREEN,
            height: "sm",
            action: {
              type: "postback",
              label: "ยืนยันการจอง",
              data: "action=confirm",
              displayText: "ยืนยันการจอง"
            }
          },
          {
            type: "button",
            style: "secondary",
            height: "sm",
            action: {
              type: "postback",
              label: "ยกเลิก / เริ่มใหม่",
              data: "action=cancel",
              displayText: "ยกเลิก"
            }
          }
        ]
      }
    }
  };
}

/**
 * 8. Build Confirmed Booking Pass Bubble Card
 */
function buildBookingSuccessPassBubble(booking, details = {}) {
  const serviceName = details.service?.name ?? "บริการซาลอน";
  const staffName = details.staff?.name ?? "ช่างประจำร้าน";
  const dateText = formatDateOnly(booking?.start_at || details.slot?.start_at);
  const timeText = `${formatTime(booking?.start_at || details.slot?.start_at)} น.`;
  const bookingRef = booking?.id ? `#${String(booking.id).slice(0, 8).toUpperCase()}` : "#CONFIRMED";

  return {
    type: "flex",
    altText: `จองสำเร็จเรียบร้อยค่ะ รหัสนัดหมาย ${bookingRef}`,
    contents: {
      type: "bubble",
      size: "mega",
      header: {
        type: "box",
        layout: "vertical",
        backgroundColor: BRAND.PRIMARY_GREEN,
        paddingAll: "lg",
        contents: [
          {
            type: "text",
            text: "BOOKING CONFIRMED",
            size: "xxs",
            color: BRAND.WHITE,
            weight: "bold"
          },
          {
            type: "text",
            text: "จองสำเร็จเรียบร้อยค่ะ 🎉",
            weight: "bold",
            color: BRAND.WHITE,
            size: "lg",
            margin: "xs"
          }
        ]
      },
      body: {
        type: "box",
        layout: "vertical",
        paddingAll: "lg",
        contents: [
          {
            type: "box",
            layout: "vertical",
            backgroundColor: BRAND.SURFACE,
            cornerRadius: "md",
            paddingAll: "md",
            alignItems: "center",
            contents: [
              {
                type: "text",
                text: "รหัสนัดหมาย (Booking Reference)",
                size: "xxs",
                color: BRAND.TEXT_SECONDARY
              },
              {
                type: "text",
                text: bookingRef,
                size: "xl",
                weight: "bold",
                color: BRAND.TEXT_PRIMARY,
                margin: "xs"
              }
            ]
          },
          {
            type: "box",
            layout: "horizontal",
            margin: "lg",
            contents: [
              { type: "text", text: "บริการ", size: "sm", color: BRAND.TEXT_SECONDARY, flex: 2 },
              { type: "text", text: serviceName, size: "sm", weight: "bold", color: BRAND.TEXT_PRIMARY, flex: 5, wrap: true }
            ]
          },
          {
            type: "box",
            layout: "horizontal",
            margin: "md",
            contents: [
              { type: "text", text: "ช่าง", size: "sm", color: BRAND.TEXT_SECONDARY, flex: 2 },
              { type: "text", text: staffName, size: "sm", weight: "bold", color: BRAND.TEXT_PRIMARY, flex: 5 }
            ]
          },
          {
            type: "box",
            layout: "horizontal",
            margin: "md",
            contents: [
              { type: "text", text: "วันและเวลา", size: "sm", color: BRAND.TEXT_SECONDARY, flex: 2 },
              { type: "text", text: `${dateText} (${timeText})`, size: "sm", weight: "bold", color: BRAND.TEXT_PRIMARY, flex: 5 }
            ]
          },
          {
            type: "separator",
            margin: "lg"
          },
          {
            type: "text",
            text: "* กรุณามาถึงก่อนเวลานัดหมาย 10 นาที หากต้องการเลื่อนหรือยกเลิก กรุณาแจ้งล่วงหน้าอย่างน้อย 24 ชม. ค่ะ",
            size: "xxs",
            color: BRAND.MUTED,
            wrap: true,
            margin: "md"
          }
        ]
      },
      footer: {
        type: "box",
        layout: "vertical",
        paddingAll: "md",
        contents: [
          {
            type: "button",
            style: "secondary",
            height: "sm",
            action: {
              type: "postback",
              label: "จองบริการอื่น",
              data: "action=restart",
              displayText: "จองบริการอื่น"
            }
          }
        ]
      }
    }
  };
}

/**
 * 9. Build Payment Required Bubble Card (State A)
 */
function buildPaymentRequiredBubble({ service, staff, slot, booking, payment, presentation } = {}) {
  const serviceName = service?.name ?? "บริการซาลอน";
  const staffName = staff?.name ?? "ช่างประจำร้าน";
  const startAt = slot?.start_at || booking?.start_at;
  const dateText = formatDateOnly(startAt);
  const timeText = `${formatTime(startAt)} น.`;
  const bookingRef = booking?.id ? `#${String(booking.id).slice(0, 8).toUpperCase()}` : "#HOLD";

  const servicePriceNum = Number(service?.price || 0);
  const servicePriceText = formatPrice(service?.price);

  const isDeposit = payment?.type === "deposit_fixed" || payment?.type === "deposit_percentage";
  const paymentTypeLabel = isDeposit ? "ชำระมัดจำเพื่อยืนยันการจอง" : "ชำระเงินเต็มจำนวนเพื่อยืนยันการจอง";
  const paymentTypeBadge = isDeposit ? "มัดจำ" : "ชำระเต็ม";

  const amountDueNum = payment?.amountDueSatang !== undefined
    ? payment.amountDueSatang / 100
    : (Number(payment?.amount_due || 0));
  const amountDueText = presentation?.displayAmount || `฿${amountDueNum.toLocaleString("th-TH")}`;

  const remainingNum = Math.max(0, servicePriceNum - amountDueNum);
  const remainingText = isDeposit ? `฿${remainingNum.toLocaleString("th-TH")}` : "฿0";

  const expiresText = payment?.expiresAt || payment?.expires_at
    ? `${formatTime(payment.expiresAt || payment.expires_at)} น.`
    : "15 นาที";

  const qrImageUrl = presentation?.qrImageUrl || "https://images.unsplash.com/photo-1563013544-824ae1b704d3?auto=format&fit=crop&w=400&q=80";

  const bodyContents = [
    {
      type: "box",
      layout: "vertical",
      backgroundColor: BRAND.SURFACE,
      cornerRadius: "md",
      paddingAll: "md",
      alignItems: "center",
      contents: [
        {
          type: "text",
          text: "รหัสการจอง (ล็อคคิวชั่วคราว)",
          size: "xxs",
          color: BRAND.TEXT_SECONDARY
        },
        {
          type: "text",
          text: bookingRef,
          size: "lg",
          weight: "bold",
          color: BRAND.TEXT_PRIMARY,
          margin: "xs"
        }
      ]
    },
    {
      type: "box",
      layout: "horizontal",
      margin: "lg",
      contents: [
        { type: "text", text: "บริการ", size: "sm", color: BRAND.TEXT_SECONDARY, flex: 2 },
        { type: "text", text: serviceName, size: "sm", weight: "bold", color: BRAND.TEXT_PRIMARY, flex: 5, wrap: true }
      ]
    },
    {
      type: "box",
      layout: "horizontal",
      margin: "sm",
      contents: [
        { type: "text", text: "ช่าง", size: "sm", color: BRAND.TEXT_SECONDARY, flex: 2 },
        { type: "text", text: staffName, size: "sm", weight: "bold", color: BRAND.TEXT_PRIMARY, flex: 5 }
      ]
    },
    {
      type: "box",
      layout: "horizontal",
      margin: "sm",
      contents: [
        { type: "text", text: "วันและเวลา", size: "sm", color: BRAND.TEXT_SECONDARY, flex: 2 },
        { type: "text", text: `${dateText} (${timeText})`, size: "sm", weight: "bold", color: BRAND.TEXT_PRIMARY, flex: 5 }
      ]
    },
    {
      type: "separator",
      margin: "md"
    },
    {
      type: "box",
      layout: "horizontal",
      margin: "md",
      contents: [
        { type: "text", text: "ราคาเต็ม", size: "sm", color: BRAND.TEXT_SECONDARY, flex: 3 },
        { type: "text", text: servicePriceText, size: "sm", color: BRAND.TEXT_PRIMARY, flex: 4, align: "end" }
      ]
    },
    {
      type: "box",
      layout: "horizontal",
      margin: "xs",
      contents: [
        { type: "text", text: "ประเภท", size: "sm", color: BRAND.TEXT_SECONDARY, flex: 3 },
        { type: "text", text: paymentTypeBadge, size: "sm", color: BRAND.TEXT_PRIMARY, flex: 4, align: "end" }
      ]
    },
    {
      type: "box",
      layout: "horizontal",
      margin: "xs",
      contents: [
        { type: "text", text: "ยอดชำระตอนนี้", size: "sm", weight: "bold", color: BRAND.TEXT_PRIMARY, flex: 3 },
        { type: "text", text: amountDueText, size: "lg", weight: "bold", color: BRAND.PRIMARY_GREEN, flex: 4, align: "end" }
      ]
    }
  ];

  if (isDeposit) {
    bodyContents.push({
      type: "box",
      layout: "horizontal",
      margin: "xs",
      contents: [
        { type: "text", text: "ยอดคงเหลือจ่ายหน้าร้าน", size: "xs", color: BRAND.MUTED, flex: 3 },
        { type: "text", text: remainingText, size: "xs", color: BRAND.TEXT_SECONDARY, flex: 4, align: "end" }
      ]
    });
  }

  bodyContents.push(
    {
      type: "box",
      layout: "horizontal",
      margin: "xs",
      contents: [
        { type: "text", text: "หมดเวลาชำระ", size: "xs", color: BRAND.MUTED, flex: 3 },
        { type: "text", text: expiresText, size: "xs", color: BRAND.MUTED, flex: 4, align: "end" }
      ]
    },
    {
      type: "box",
      layout: "vertical",
      margin: "lg",
      alignItems: "center",
      contents: [
        {
          type: "image",
          url: qrImageUrl,
          size: "xl",
          aspectRatio: "1:1",
          aspectMode: "cover"
        },
        {
          type: "text",
          text: "เมื่อชำระแล้ว ส่งรูปสลิปในแชทนี้ได้เลย",
          size: "xs",
          weight: "bold",
          color: BRAND.DARK,
          margin: "md",
          align: "center"
        },
        {
          type: "text",
          text: "* ระบบทดสอบ (Mock Payment Presentation)",
          size: "xxs",
          color: BRAND.MUTED,
          margin: "xs",
          align: "center"
        }
      ]
    }
  );

  return {
    type: "flex",
    altText: `กรุณาชำระเงิน ${amountDueText} เพื่อยืนยันการจอง (รหัส ${bookingRef})`,
    contents: {
      type: "bubble",
      size: "mega",
      header: {
        type: "box",
        layout: "vertical",
        backgroundColor: BRAND.DARK,
        paddingAll: "lg",
        contents: [
          {
            type: "text",
            text: "Salon Booking OS",
            size: "xxs",
            color: BRAND.PRIMARY_GREEN,
            weight: "bold"
          },
          {
            type: "text",
            text: paymentTypeLabel,
            weight: "bold",
            color: BRAND.WHITE,
            size: "md",
            margin: "xs",
            wrap: true
          }
        ]
      },
      body: {
        type: "box",
        layout: "vertical",
        paddingAll: "lg",
        contents: bodyContents
      },
      footer: {
        type: "box",
        layout: "vertical",
        paddingAll: "md",
        contents: [
          {
            type: "button",
            style: "secondary",
            height: "sm",
            action: {
              type: "postback",
              label: "ยกเลิกการจอง",
              data: "action=cancel",
              displayText: "ยกเลิกการจอง"
            }
          }
        ]
      }
    }
  };
}

/**
 * 10. Build Slip Received Bubble Card (State B)
 */
function buildSlipReceivedBubble({ booking, payment } = {}) {
  const bookingRef = booking?.id ? `#${String(booking.id).slice(0, 8).toUpperCase()}` : "#VERIFY";
  return {
    type: "flex",
    altText: "ได้รับสลิปแล้ว กำลังตรวจสอบ กรุณารอสักครู่ค่ะ",
    contents: {
      type: "bubble",
      size: "kilo",
      header: {
        type: "box",
        layout: "vertical",
        backgroundColor: BRAND.DARK,
        paddingAll: "lg",
        contents: [
          { type: "text", text: "Salon Booking OS", size: "xxs", color: BRAND.PRIMARY_GREEN, weight: "bold" },
          { type: "text", text: "ได้รับสลิปแล้ว กำลังตรวจสอบ", weight: "bold", color: BRAND.WHITE, size: "md", margin: "xs" }
        ]
      },
      body: {
        type: "box",
        layout: "vertical",
        paddingAll: "lg",
        contents: [
          {
            type: "box",
            layout: "vertical",
            backgroundColor: BRAND.SURFACE,
            cornerRadius: "md",
            paddingAll: "md",
            alignItems: "center",
            contents: [
              { type: "text", text: "รหัสการจอง", size: "xxs", color: BRAND.TEXT_SECONDARY },
              { type: "text", text: bookingRef, size: "md", weight: "bold", color: BRAND.TEXT_PRIMARY, margin: "xs" }
            ]
          },
          {
            type: "text",
            text: "ระบบได้รับรูปสลิปของท่านแล้ว กำลังดำเนินการตรวจสอบยอดเงินอัตโนมัติ กรุณารอสักครู่ค่ะ",
            size: "xs",
            color: BRAND.TEXT_SECONDARY,
            wrap: true,
            margin: "md"
          }
        ]
      }
    }
  };
}

/**
 * 11. Build Payment Verified Bubble Card (State C)
 */
function buildPaymentVerifiedBubble({ booking, payment } = {}) {
  const bookingRef = booking?.id ? `#${String(booking.id).slice(0, 8).toUpperCase()}` : "#PAID";
  return {
    type: "flex",
    altText: "ชำระเงินสำเร็จเรียบร้อยค่ะ 🎉",
    contents: {
      type: "bubble",
      size: "kilo",
      header: {
        type: "box",
        layout: "vertical",
        backgroundColor: BRAND.PRIMARY_GREEN,
        paddingAll: "lg",
        contents: [
          { type: "text", text: "Salon Booking OS", size: "xxs", color: BRAND.DARK, weight: "bold" },
          { type: "text", text: "ชำระเงินสำเร็จ 🎉", weight: "bold", color: BRAND.WHITE, size: "lg", margin: "xs" }
        ]
      },
      body: {
        type: "box",
        layout: "vertical",
        paddingAll: "lg",
        contents: [
          {
            type: "box",
            layout: "vertical",
            backgroundColor: BRAND.SURFACE,
            cornerRadius: "md",
            paddingAll: "md",
            alignItems: "center",
            contents: [
              { type: "text", text: "รหัสการจอง", size: "xxs", color: BRAND.TEXT_SECONDARY },
              { type: "text", text: bookingRef, size: "md", weight: "bold", color: BRAND.TEXT_PRIMARY, margin: "xs" }
            ]
          },
          {
            type: "text",
            text: "การชำระเงินได้รับการยืนยันเรียบร้อยแล้ว การจองของท่านได้รับการยืนยันค่ะ",
            size: "xs",
            color: BRAND.TEXT_SECONDARY,
            wrap: true,
            margin: "md"
          }
        ]
      },
      footer: {
        type: "box",
        layout: "vertical",
        paddingAll: "md",
        contents: [
          {
            type: "button",
            style: "secondary",
            height: "sm",
            action: { type: "postback", label: "จองบริการอื่น", data: "action=restart", displayText: "จองบริการอื่น" }
          }
        ]
      }
    }
  };
}

/**
 * 12. Build Manual Review Bubble Card (State D)
 */
function buildPaymentManualReviewBubble({ booking, payment, reason } = {}) {
  const bookingRef = booking?.id ? `#${String(booking.id).slice(0, 8).toUpperCase()}` : "#REVIEW";
  return {
    type: "flex",
    altText: "ระบบส่งให้ร้านตรวจสอบยอดเงินค่ะ",
    contents: {
      type: "bubble",
      size: "kilo",
      header: {
        type: "box",
        layout: "vertical",
        backgroundColor: BRAND.DARK,
        paddingAll: "lg",
        contents: [
          { type: "text", text: "Salon Booking OS", size: "xxs", color: BRAND.PRIMARY_GREEN, weight: "bold" },
          { type: "text", text: "ระบบส่งให้ร้านตรวจสอบ", weight: "bold", color: BRAND.WHITE, size: "md", margin: "xs" }
        ]
      },
      body: {
        type: "box",
        layout: "vertical",
        paddingAll: "lg",
        contents: [
          {
            type: "box",
            layout: "vertical",
            backgroundColor: BRAND.SURFACE,
            cornerRadius: "md",
            paddingAll: "md",
            alignItems: "center",
            contents: [
              { type: "text", text: "รหัสการจอง", size: "xxs", color: BRAND.TEXT_SECONDARY },
              { type: "text", text: bookingRef, size: "md", weight: "bold", color: BRAND.TEXT_PRIMARY, margin: "xs" }
            ]
          },
          {
            type: "text",
            text: reason || "ระบบได้ส่งรายการสลิปให้ทางร้านตรวจสอบยอดเงินโดยตรงแล้วค่ะ",
            size: "xs",
            color: BRAND.TEXT_PRIMARY,
            wrap: true,
            margin: "md"
          },
          {
            type: "text",
            text: "เจ้าหน้าที่จะตรวจสอบและยืนยันนัดหมายให้ท่านโดยเร็วที่สุดค่ะ",
            size: "xxs",
            color: BRAND.MUTED,
            wrap: true,
            margin: "xs"
          }
        ]
      },
      footer: {
        type: "box",
        layout: "vertical",
        paddingAll: "md",
        contents: [
          {
            type: "button",
            style: "secondary",
            height: "sm",
            action: { type: "postback", label: "จองบริการอื่น", data: "action=restart", displayText: "จองบริการอื่น" }
          }
        ]
      }
    }
  };
}

/**
 * 13. Build Verification Failed Bubble Card (State E)
 */
function buildPaymentFailedBubble({ booking, payment, reason } = {}) {
  const bookingRef = booking?.id ? `#${String(booking.id).slice(0, 8).toUpperCase()}` : "#RETRY";
  return {
    type: "flex",
    altText: reason || "ตรวจสอบสลิปไม่สำเร็จ กรุณาส่งรูปใหม่อีกครั้งค่ะ",
    contents: {
      type: "bubble",
      size: "kilo",
      header: {
        type: "box",
        layout: "vertical",
        backgroundColor: BRAND.DARK,
        paddingAll: "lg",
        contents: [
          { type: "text", text: "Salon Booking OS", size: "xxs", color: BRAND.MUTED, weight: "bold" },
          { type: "text", text: "ตรวจสอบสลิปไม่สำเร็จ", weight: "bold", color: BRAND.WHITE, size: "md", margin: "xs" }
        ]
      },
      body: {
        type: "box",
        layout: "vertical",
        paddingAll: "lg",
        contents: [
          {
            type: "box",
            layout: "vertical",
            backgroundColor: BRAND.SURFACE,
            cornerRadius: "md",
            paddingAll: "md",
            alignItems: "center",
            contents: [
              { type: "text", text: "รหัสการจอง", size: "xxs", color: BRAND.TEXT_SECONDARY },
              { type: "text", text: bookingRef, size: "md", weight: "bold", color: BRAND.TEXT_PRIMARY, margin: "xs" }
            ]
          },
          {
            type: "text",
            text: reason || "ไม่สามารถตรวจสอบสลิปได้ หรือยอดเงินไม่ตรงกับรายการจองค่ะ",
            size: "xs",
            color: BRAND.TEXT_PRIMARY,
            wrap: true,
            margin: "md"
          },
          {
            type: "text",
            text: "กรุณาตรวจสอบความถูกต้องและส่งรูปสลิปใหม่อีกครั้งในแชทนี้ค่ะ",
            size: "xxs",
            color: BRAND.MUTED,
            wrap: true,
            margin: "xs"
          }
        ]
      },
      footer: {
        type: "box",
        layout: "vertical",
        paddingAll: "md",
        contents: [
          {
            type: "button",
            style: "secondary",
            height: "sm",
            action: { type: "postback", label: "ยกเลิกการจอง", data: "action=cancel", displayText: "ยกเลิกการจอง" }
          }
        ]
      }
    }
  };
}

/**
 * 14. Build Payment Expired Bubble Card (State F)
 */
function buildPaymentExpiredBubble({ booking, payment } = {}) {
  const bookingRef = booking?.id ? `#${String(booking.id).slice(0, 8).toUpperCase()}` : "#EXPIRED";
  return {
    type: "flex",
    altText: "รายการชำระเงินหมดเวลาแล้วค่ะ กรุณาจองใหม่ค่ะ",
    contents: {
      type: "bubble",
      size: "kilo",
      header: {
        type: "box",
        layout: "vertical",
        backgroundColor: BRAND.DARK,
        paddingAll: "lg",
        contents: [
          { type: "text", text: "Salon Booking OS", size: "xxs", color: BRAND.MUTED, weight: "bold" },
          { type: "text", text: "รายการชำระเงินหมดเวลา", weight: "bold", color: BRAND.WHITE, size: "md", margin: "xs" }
        ]
      },
      body: {
        type: "box",
        layout: "vertical",
        paddingAll: "lg",
        contents: [
          {
            type: "box",
            layout: "vertical",
            backgroundColor: BRAND.SURFACE,
            cornerRadius: "md",
            paddingAll: "md",
            alignItems: "center",
            contents: [
              { type: "text", text: "รหัสการจอง", size: "xxs", color: BRAND.TEXT_SECONDARY },
              { type: "text", text: bookingRef, size: "md", weight: "bold", color: BRAND.TEXT_PRIMARY, margin: "xs" }
            ]
          },
          {
            type: "text",
            text: "รายการชำระเงินนี้หมดอายุแล้ว ระบบได้ยกเลิกและปล่อยคิวเรียบร้อยค่ะ หากต้องการใช้บริการ กรุณากดจองใหม่ค่ะ",
            size: "xs",
            color: BRAND.TEXT_SECONDARY,
            wrap: true,
            margin: "md"
          }
        ]
      },
      footer: {
        type: "box",
        layout: "vertical",
        paddingAll: "md",
        contents: [
          {
            type: "button",
            style: "primary",
            color: BRAND.PRIMARY_GREEN,
            height: "sm",
            action: { type: "postback", label: "จองบริการใหม่", data: "action=restart", displayText: "จองบริการใหม่" }
          }
        ]
      }
    }
  };
}

module.exports = {
  BRAND,
  buildServiceCarousel,
  buildCategorySelectionBubble,
  buildStaffCarousel,
  buildDateSelectionBubble,
  buildSlotSelectionBubble,
  buildContactPromptBubble,
  buildReviewTicketBubble,
  buildBookingSuccessPassBubble,
  buildPaymentRequiredBubble,
  buildSlipReceivedBubble,
  buildPaymentVerifiedBubble,
  buildPaymentManualReviewBubble,
  buildPaymentFailedBubble,
  buildPaymentExpiredBubble,
  getServiceImage,
  getServiceCategory,
  getStaffImage,
  formatPrice,
  formatDateOnly,
  formatTime,
  truncate
};

