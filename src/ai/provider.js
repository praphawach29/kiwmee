class AIProvider {
  async interpret() { throw new Error("AIProvider.interpret must be implemented"); }
}

// Deterministic pilot provider. No external model calls or free-form generated claims.
class MockAIProvider extends AIProvider {
  async interpret({ message, state }) {
    const text = message.trim();
    if (/ร้องเรียน|ส่วนลด|ลดราคา|ยกเว้น|คุยกับคน|พนักงาน|complaint|discount|exception|human/i.test(text)) return { intent: "handoff" };
    if (text === "ยืนยัน") return { intent: "confirm" };
    if (text === "เริ่มใหม่" || text === "บริการ") return { intent: "services" };
    if (text.startsWith("ดูนัด ")) return { intent: "manage", value: text.slice(6).trim() };
    if (text === "เลื่อนนัด") return { intent: "reschedule" };
    if (text === "ยกเลิกนัด") return { intent: "cancel" };
    if (["start", "service"].includes(state.stage) && /พรุ่งนี้|วันนี้|\d{4}-\d{2}-\d{2}/.test(text)) return { intent: "search", value: text };
    if (state.stage === "service") return { intent: "service", value: text };
    if (state.stage === "staff") return { intent: "staff", value: text };
    if (state.stage === "date") return { intent: "date", value: text };
    if (state.stage === "slot") return { intent: "slot", value: text };
    if (state.stage === "contact") return { intent: "contact", value: text };
    return { intent: "unknown" };
  }
}

const { logEvent } = require("../observability/logger");

class OpenAIProvider extends AIProvider {
  constructor(options = {}) {
    super();
    this.apiKey = options.apiKey; this.model = options.model; this.fetch = options.fetch ?? globalThis.fetch;
    this.instructions = options.instructions ?? "คุณเป็นตัวจำแนกเจตนาสำหรับผู้ช่วยจองร้าน ตอบผ่าน tool ที่กำหนดเท่านั้น ห้ามสร้างข้อมูลร้าน ราคา เวลา หรือสิทธิ์ใหม่";
  }
  async interpret({ message, state }) {
    if (!this.apiKey || !this.model) {
      logEvent("ai_provider_error", { code: "AI_PROVIDER_NOT_CONFIGURED", error: "API key or model missing", model: this.model ?? "unset" }, console.error);
      const error = new Error("AI provider is not configured"); error.code = "AI_PROVIDER_UNAVAILABLE"; throw error;
    }
    let response;
    try {
      response = await this.fetch("https://api.openai.com/v1/responses", {
        method: "POST", signal: AbortSignal.timeout(15000),
        headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ model: this.model, store: false, instructions: this.instructions,
          input: [{ role: "user", content: [{ type: "input_text", text: JSON.stringify({ message, stage: state.stage,
            available_services: state.services ?? [], available_staff: state.staff ?? [] }) }] }],
          tools: [{ type: "function", name: "select_receptionist_action", strict: true,
            description: "Select exactly one allowed receptionist intent. Preserve a selected label or user value verbatim.",
            parameters: { type: "object", additionalProperties: false,
              properties: { intent: { type: "string", enum: ["services","service","staff","date","slot","contact","manage","reschedule","cancel","confirm","handoff","search","unknown"] },
                value: { anyOf: [{ type: "string", maxLength: 2000 }, { type: "null" }] } }, required: ["intent","value"] } }],
          tool_choice: { type: "function", name: "select_receptionist_action" }, parallel_tool_calls: false,
          max_output_tokens: 200 })
      });
    } catch (err) {
      logEvent("ai_provider_error", {
        code: "AI_PROVIDER_FETCH_ERROR",
        status: 0,
        error: err?.message ?? "Fetch error",
        model: this.model
      }, console.error);
      const error = new Error("AI provider unavailable"); error.code = "AI_PROVIDER_UNAVAILABLE"; throw error;
    }
    if (!response.ok) {
      let rawError = "";
      try {
        const errJson = await response.json();
        rawError = errJson?.error?.message || errJson?.error?.code || response.statusText;
      } catch {
        try { rawError = await response.text(); } catch {}
      }
      logEvent("ai_provider_error", {
        code: "AI_PROVIDER_HTTP_ERROR",
        status: response.status,
        error: rawError || response.statusText,
        model: this.model
      }, console.error);
      const error = new Error("AI provider unavailable"); error.code = "AI_PROVIDER_UNAVAILABLE"; throw error;
    }
    const body = await response.json();
    const call = body.output?.find((item) => item.type === "function_call" && item.name === "select_receptionist_action");
    if (!call || typeof call.arguments !== "string") {
      logEvent("ai_provider_error", {
        code: "AI_PROVIDER_INVALID_OUTPUT",
        error: `Missing tool call in output: ${body.output ? JSON.stringify(body.output.map((o) => o.type)) : "no_output"}`,
        model: this.model
      }, console.error);
      const error = new Error("Invalid AI provider response"); error.code = "AI_PROVIDER_INVALID"; throw error;
    }
    try {
      return JSON.parse(call.arguments);
    } catch (err) {
      logEvent("ai_provider_error", {
        code: "AI_PROVIDER_JSON_ERROR",
        error: err?.message ?? "JSON parse error",
        model: this.model
      }, console.error);
      const error = new Error("Invalid AI provider response"); error.code = "AI_PROVIDER_INVALID"; throw error;
    }
  }
}

function createAIProvider(config, options = {}) {
  if (config.aiProvider === "openai") return new OpenAIProvider({ apiKey: config.openaiApiKey, model: config.aiModel, ...options });
  return new MockAIProvider();
}
module.exports = { AIProvider, MockAIProvider, OpenAIProvider, createAIProvider };
