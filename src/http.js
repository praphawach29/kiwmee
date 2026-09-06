const { AppError } = require("./errors");

function json(data, status = 200) {
  return Response.json({ data }, { status });
}

function jsonError(error) {
  const appError = normalizeError(error);
  const body = {
    error: {
      code: appError.code,
      message: appError.message
    }
  };

  if (appError.details) {
    body.error.details = appError.details;
  }

  return Response.json(body, { status: appError.status });
}

async function readJson(request) {
  try {
    return await request.json();
  } catch (error) {
    throw new AppError("BAD_REQUEST", "request body must be valid JSON", 400);
  }
}

function normalizeError(error) {
  if (error instanceof AppError) {
    return error;
  }

  const message = error?.message ?? "Internal server error";
  if (/not found/i.test(message)) {
    return new AppError("NOT_FOUND", message, 404);
  }
  if (/not available|overlap|conflict|cannot perform|constraint|duplicate/i.test(message)) {
    return new AppError("CONFLICT", message, 409);
  }
  if (/cancellation window/i.test(message)) {
    return new AppError("FORBIDDEN", message, 403);
  }

  return new AppError("INTERNAL_SERVER_ERROR", message, 500);
}

async function route(handler) {
  try {
    return await handler();
  } catch (error) {
    return jsonError(error);
  }
}

async function getParams(context) {
  return Promise.resolve(context?.params ?? {});
}

module.exports = {
  getParams,
  json,
  jsonError,
  readJson,
  route
};
