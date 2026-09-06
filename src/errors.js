class AppError extends Error {
  constructor(code, message, status = 400, details = undefined) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function badRequest(message, details) {
  return new AppError("BAD_REQUEST", message, 400, details);
}

function notFound(message) {
  return new AppError("NOT_FOUND", message, 404);
}

function conflict(message) {
  return new AppError("CONFLICT", message, 409);
}

function forbidden(message) {
  return new AppError("FORBIDDEN", message, 403);
}

module.exports = {
  AppError,
  badRequest,
  conflict,
  forbidden,
  notFound
};
