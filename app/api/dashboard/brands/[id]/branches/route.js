const { brandRoute } = require("../../../../../../src/v2/admin-routes");
const { addBranch } = require("../../../../../../src/v2/admin-brands");

// A new branch: { name, slug, copyFrom?: branch slug, copyResources?: boolean } — brand owners, within the plan's limit
const POST = brandRoute((client, body, { id }) => addBranch(client, id, body), { created: true });

module.exports = { POST };
