const { PgPilotRepository } = require("./pg-pilot-repository");
let repository;
function getPilotRepository() { if (!repository) repository = new PgPilotRepository(); return repository; }
function setPilotRepository(repo) { repository = repo; }
async function closePilotRepository() { if (repository) { if (typeof repository.close === "function") await repository.close(); repository = null; } }
module.exports = { getPilotRepository, setPilotRepository, closePilotRepository };
