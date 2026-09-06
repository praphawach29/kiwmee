const { validateRuntimeConfig } = require("./src/config");
async function register() {
  if (process.env.PILOT_STRICT_CONFIG === "true") validateRuntimeConfig();
}
module.exports = { register };
