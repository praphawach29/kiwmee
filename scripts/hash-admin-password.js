const { randomBytes, scryptSync } = require("node:crypto");
const password = process.env.ADMIN_PASSWORD_PLAIN;
if (!password || password.length < 12) {
  console.error("Set ADMIN_PASSWORD_PLAIN to at least 12 characters for this command only.");
  process.exit(1);
}
const salt = randomBytes(16).toString("hex");
const digest = scryptSync(password, salt, 32).toString("hex");
console.log(`scrypt$${salt}$${digest}`);
