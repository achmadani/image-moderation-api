'use strict';

/**
 * Every error the API can emit. The code is part of the public contract, so it
 * is defined here once and reused by routes, services and tests.
 */
const ERROR_CODES = Object.freeze({
  NO_IMAGE_PROVIDED: 400,
  INVALID_INPUT: 400,
  DECODE_FAILED: 400,
  IMAGE_TOO_LARGE_DIMENSIONS: 400,
  UNAUTHORIZED: 401,
  FILE_TOO_LARGE: 413,
  BATCH_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  URL_FETCH_FAILED: 422,
  RATE_LIMITED: 429,
  MODEL_NOT_READY: 503,
  INFERENCE_TIMEOUT: 504,
  INTERNAL_ERROR: 500,
});

class AppError extends Error {
  /**
   * @param {keyof ERROR_CODES} code
   * @param {string} message human-readable, safe to return to the caller
   * @param {object} [details] structured context, must not contain image bytes
   */
  constructor(code, message, details = {}) {
    super(message);
    if (!Object.prototype.hasOwnProperty.call(ERROR_CODES, code)) {
      throw new Error(`Unknown error code: ${code}`);
    }
    this.name = 'AppError';
    this.code = code;
    this.statusCode = ERROR_CODES[code];
    this.details = details;
    Error.captureStackTrace(this, AppError);
  }

  /** Shape used inside both the single and the batch response. */
  toPayload() {
    return { code: this.code, message: this.message, details: this.details };
  }
}

const isAppError = (err) => err instanceof AppError;

/**
 * Normalises anything thrown inside a request into an AppError, so an
 * unexpected failure never leaks a stack trace or an internal message.
 */
function toAppError(err) {
  if (isAppError(err)) return err;
  return new AppError('INTERNAL_ERROR', 'An unexpected error occurred');
}

function errorResponse(err, requestId) {
  const appErr = toAppError(err);
  return {
    success: false,
    error: appErr.toPayload(),
    meta: { requestId },
  };
}

const fail = (code, message, details) => new AppError(code, message, details);

module.exports = { ERROR_CODES, AppError, isAppError, toAppError, errorResponse, fail };
