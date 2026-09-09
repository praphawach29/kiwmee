const { createHmac, timingSafeEqual } = require("node:crypto");
class MessagingProvider {
  verifySignature() { throw new Error("verifySignature must be implemented"); }
  async replyText() { throw new Error("replyText must be implemented"); }
  async replyMessages() { throw new Error("replyMessages must be implemented"); }
  async pushText() { throw new Error("pushText must be implemented"); }
  async pushMessages() { throw new Error("pushMessages must be implemented"); }
}
class LineMessagingProvider extends MessagingProvider {
  constructor({ channelSecret, accessToken, fetch = globalThis.fetch }) {
    super(); this.channelSecret = channelSecret; this.accessToken = accessToken; this.fetch = fetch;
  }
  verifySignature(raw, signature) {
    if (!this.channelSecret || !signature) return false;
    const expected = createHmac("sha256", this.channelSecret).update(raw).digest("base64");
    const left = Buffer.from(signature); const right = Buffer.from(expected);
    return left.length === right.length && timingSafeEqual(left, right);
  }
  async replyMessages(replyToken, messages) { return this.send("reply", { replyToken, messages }); }
  async replyText(replyToken, text) { return this.replyMessages(replyToken, [{ type: "text", text: truncate(text) }]); }
  async pushMessages(to, messages) { return this.send("push", { to, messages }); }
  async pushText(to, text) { return this.pushMessages(to, [{ type: "text", text: truncate(text) }]); }
  async send(kind, body) {
    const response = await this.fetch(`https://api.line.me/v2/bot/message/${kind}`, { method: "POST",
      signal: AbortSignal.timeout(10000), headers: { authorization: `Bearer ${this.accessToken}`, "content-type": "application/json" },
      body: JSON.stringify(body) });
    if (!response.ok) { const error = new Error("LINE delivery failed"); error.code = "MESSAGING_PROVIDER_ERROR"; throw error; }
    return { delivered: true };
  }
}
class MockMessagingProvider extends MessagingProvider {
  constructor(secret = "test-line-secret") { super(); this.channelSecret = secret; this.replies = []; this.pushes = []; }
  verifySignature(raw, signature) { return new LineMessagingProvider({ channelSecret: this.channelSecret }).verifySignature(raw, signature); }
  async replyMessages(replyToken, messages) {
    const text = messages.map((m) => m.text).filter(Boolean).join("\n");
    this.replies.push({ replyToken, messages, text });
    return { delivered: true };
  }
  async replyText(replyToken, text) {
    this.replies.push({ replyToken, text, messages: [{ type: "text", text: truncate(text) }] });
    return { delivered: true };
  }
  async pushMessages(to, messages) {
    const text = messages.map((m) => m.text).filter(Boolean).join("\n");
    this.pushes.push({ to, messages, text });
    return { delivered: true };
  }
  async pushText(to, text) {
    this.pushes.push({ to, text, messages: [{ type: "text", text: truncate(text) }] });
    return { delivered: true };
  }
}
function truncate(text) { return String(text).slice(0, 5000); }
module.exports = { MessagingProvider, LineMessagingProvider, MockMessagingProvider };
