const { shopRoute } = require("../../../../../../src/v2/admin-routes");
const { getTeam, inviteMember } = require("../../../../../../src/v2/admin-team");

// Owners: the shop's members and open invites · POST { email, role } to invite
const GET = shopRoute((client, shop) => getTeam(client, shop), { read: true });
const POST = shopRoute((client, shop, body) => inviteMember(client, shop, body));

module.exports = { GET, POST };
