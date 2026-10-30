const { superRoute } = require("../../../../src/v2/admin-routes");
const { listSettings, saveSetting, clearSetting } = require("../../../../src/v2/platform-settings");

// Platform settings for the platform admins (/super): the list never contains a secret's value
const GET = superRoute((client) => listSettings(client), { read: true });
const PUT = superRoute((client, body) => saveSetting(client, body));
const DELETE = superRoute((client, body) => clearSetting(client, body));

module.exports = { GET, PUT, DELETE };
