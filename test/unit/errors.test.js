'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { ERROR_CODES, AppError, isAppError, toAppError, errorResponse, fail } = require('../../src/utils/errors');

test('every error code required by the API contract exists with the right status', () => {
  const expected = {
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
  };
  assert.deepStrictEqual(ERROR_CODES, expected);
});

test('AppError carries code, status, message and details', () => {
  const err = new AppError('FILE_TOO_LARGE', 'too big', { limit: 10 });
  assert.strictEqual(err.code, 'FILE_TOO_LARGE');
  assert.strictEqual(err.statusCode, 413);
  assert.strictEqual(err.message, 'too big');
  assert.deepStrictEqual(err.details, { limit: 10 });
  assert.ok(err instanceof Error);
  assert.ok(err.stack);
});

test('AppError defaults details to an empty object', () => {
  assert.deepStrictEqual(new AppError('INVALID_INPUT', 'x').details, {});
});

test('AppError rejects a code outside the contract', () => {
  assert.throws(() => new AppError('NOT_A_REAL_CODE', 'x'), /Unknown error code: NOT_A_REAL_CODE/);
});

test('toPayload emits exactly code, message and details', () => {
  const payload = new AppError('DECODE_FAILED', 'nope', { reason: 'bad header' }).toPayload();
  assert.deepStrictEqual(payload, { code: 'DECODE_FAILED', message: 'nope', details: { reason: 'bad header' } });
});

test('isAppError distinguishes our errors from plain ones', () => {
  assert.strictEqual(isAppError(fail('INVALID_INPUT', 'x')), true);
  assert.strictEqual(isAppError(new Error('boom')), false);
  assert.strictEqual(isAppError(null), false);
  assert.strictEqual(isAppError('UNAUTHORIZED'), false);
});

test('toAppError passes an AppError through untouched', () => {
  const original = fail('RATE_LIMITED', 'slow down', { limit: 5 });
  assert.strictEqual(toAppError(original), original);
});

test('toAppError converts an unknown error into INTERNAL_ERROR without leaking it', () => {
  const converted = toAppError(new Error('ECONNREFUSED /var/run/secret.sock'));
  assert.strictEqual(converted.code, 'INTERNAL_ERROR');
  assert.strictEqual(converted.statusCode, 500);
  assert.strictEqual(converted.message, 'An unexpected error occurred');
  assert.ok(!converted.message.includes('secret'));
  assert.deepStrictEqual(converted.details, {});
});

test('errorResponse produces the documented failure envelope', () => {
  const body = errorResponse(fail('UNAUTHORIZED', 'Missing X-API-Key header'), 'req-1');
  assert.deepStrictEqual(body, {
    success: false,
    error: { code: 'UNAUTHORIZED', message: 'Missing X-API-Key header', details: {} },
    meta: { requestId: 'req-1' },
  });
});

test('errorResponse normalises a non-AppError too', () => {
  const body = errorResponse(new TypeError('undefined is not a function'), 'req-2');
  assert.strictEqual(body.success, false);
  assert.strictEqual(body.error.code, 'INTERNAL_ERROR');
  assert.strictEqual(body.meta.requestId, 'req-2');
});

test('fail is a constructor shorthand for AppError', () => {
  const err = fail('MODEL_NOT_READY', 'warming up');
  assert.ok(err instanceof AppError);
  assert.strictEqual(err.statusCode, 503);
});
