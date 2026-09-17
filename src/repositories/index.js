const { PgBookingRepository } = require("./pg-booking-repository");
const { PgPaymentRepository } = require("./pg-payment-repository");

let repository;

function getRepository() {
  if (!repository) {
    repository = new PgBookingRepository();
  }
  return repository;
}

function setRepository(repo) {
  repository = repo;
}

async function closeRepository() {
  if (repository) {
    if (typeof repository.close === "function") {
      await repository.close();
    }
    repository = null;
  }
}

module.exports = {
  closeRepository,
  getRepository,
  setRepository,
  PgBookingRepository,
  PgPaymentRepository
};

