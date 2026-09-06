const { getRepository, closeRepository } = require("../src/repositories");
const { runAutomationCycle } = require("../src/automation/automation-service");
const { createNotificationProvider } = require("../src/automation/provider-factory");
const { getPilotConfig } = require("../src/config");

async function main() {
  try {
    const repository = getRepository();
    const result = await runAutomationCycle(repository, { provider: createNotificationProvider(repository, getPilotConfig()) });
    console.log(JSON.stringify(result));
    if (result.jobs.some((job) => job.status === "failed")) process.exitCode = 1;
  } finally {
    await closeRepository();
    await require("../src/repositories/pilot").closePilotRepository();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
