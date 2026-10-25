// Shared shape of the app/api/dashboard/shops/[slug]/* routes: signed in → member (or owner) of the
// shop in the URL → one transaction as that user → JSON.

const { getParams, json } = require("../http");
const { boundedJson, sameOrigin } = require("../security/limits");
const { adminRoute } = require("./admin-auth");
const { asUser, memberShop } = require("./admin-catalog");
const { getBookingPool } = require("./db");

/**
 * action(client, shop, body, params) → result
 *   owner: only the shop's owners (default for writes); body: read a JSON body (else only check Origin)
 */
function shopRoute(action, { owner = true, body = true, read = false } = {}) {
  return (request, context) =>
    adminRoute(request, async (user) => {
      const params = await getParams(context);
      let input;
      if (read) input = undefined;
      else if (body) input = await boundedJson(request);
      else sameOrigin(request);
      const result = await asUser(getBookingPool(), user, async (client) =>
        action(client, await memberShop(client, params.slug, { owner }), input, params)
      );
      return json(result ?? { ok: true }, !read && body && !params.id && request.method === "POST" ? 201 : 200);
    });
}

module.exports = { shopRoute };
