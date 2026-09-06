const { PgPilotRepository } = require("./pg-pilot-repository");
let repository;
function getPilotRepository() { if (!repository) repository = new PgPilotRepository(); return repository; }
async function closePilotRepository() { if (repository) { await repository.close(); repository = null; } }
module.exports = { getPilotRepository, closePilotRepository };
