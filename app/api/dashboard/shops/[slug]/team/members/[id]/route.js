const { shopRoute } = require("../../../../../../../../src/v2/admin-routes");
const { removeMember, setMemberRole } = require("../../../../../../../../src/v2/admin-team");

// Owners: PUT { role } changes a member's role · DELETE removes them (a shop keeps one owner)
const PUT = shopRoute((client, shop, body, { id }) => setMemberRole(client, shop, id, body));
const DELETE = shopRoute((client, shop, body, { id }) => removeMember(client, shop, id), { body: false });

module.exports = { PUT, DELETE };
