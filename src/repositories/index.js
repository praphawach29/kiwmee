const { PgBookingRepository } = require("./pg-booking-repository");

let repository;

function getRepository() {
  if (!repository) {
    repository = new PgBookingRepository();
  }
  return repository;
}

async function closeRepository() {
  if (repository) {
    await repository.close();
    repository = null;
  }
}

module.exports = {
  closeRepository,
  getRepository,
  PgBookingRepository
};
