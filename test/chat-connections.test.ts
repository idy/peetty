import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LOCAL_MAGPIE, localMagpieConnection, normalizeModelOptions } from '../src/chat/connections.ts';

describe('model header validation', () => {
  it('validates and canonicalizes a copied string-valued header record', () => {
    const headers = { Authorization: '  Bearer gateway-secret  ', 'X-Api-Key': ' gateway-key ' };
    const model = normalizeModelOptions({ id: 'model', baseUrl: 'https://api.example', headers });
    assert.deepEqual(model.headers, { authorization: 'Bearer gateway-secret', 'x-api-key': 'gateway-key' });
    assert.notEqual(model.headers, headers);
    assert.deepEqual(headers, { Authorization: '  Bearer gateway-secret  ', 'X-Api-Key': ' gateway-key ' });
  });

  it('rejects malformed JavaScript header inputs with sanitized errors', () => {
    const throwing = Object.defineProperty({}, 'Authorization', { enumerable: true, get() { throw new Error('private-secret'); } });
    const invalid: unknown[] = [
      null, 123, 'private-secret', [], new Headers({ Authorization: 'private-secret' }),
      { Authorization: 123 }, { Authorization: null }, { 'X-Key': undefined },
      { 'bad header': 'private-secret' },
      { Authorization: 'Bearer private-secret' + String.fromCharCode(13, 10) + 'X-Injected: true' },
      throwing,
    ];
    for (const headers of invalid) {
      assert.throws(() => normalizeModelOptions({ id: 'model', baseUrl: 'https://api.example', headers: headers as Record<string, string> }), (error: Error) => {
        assert.equal(error.message, 'Enter a valid API base URL and model ID.');
        assert.ok(!error.message.includes('private-secret'));
        return true;
      });
    }
  });
});

describe('local Magpie shortcut credentials', () => {
  it('uses the default loopback gateway without embedding credentials or a model choice', () => {
    assert.deepEqual(LOCAL_MAGPIE, { baseUrl: 'http://127.0.0.1:3425/v1' });
    assert.equal(Object.isFrozen(LOCAL_MAGPIE), true);
    assert.deepEqual(localMagpieConnection(), { ...LOCAL_MAGPIE, id: '' });
  });

  it('never carries a remote provider key, callback or custom headers into Magpie', () => {
    let calls = 0;
    const connection = localMagpieConnection({
      baseUrl: 'https://remote.example/v1', id: 'remote-model', apiKey: 'remote-secret',
      getApiKey: () => { calls++; return 'remote-secret'; }, headers: { Authorization: 'Bearer remote-secret' },
    });
    assert.deepEqual(connection, { ...LOCAL_MAGPIE, id: '' });
    assert.equal(calls, 0);
  });

  it('reuses the current gateway connection without resolving credentials or aliasing headers', () => {
    let calls = 0;
    const getApiKey = () => { calls++; return 'gateway-secret'; };
    const headers = { 'x-gateway': 'test' };
    const connection = localMagpieConnection({ ...LOCAL_MAGPIE, id: 'chosen-model', getApiKey, headers });
    assert.equal(connection.id, 'chosen-model');
    assert.equal(connection.getApiKey, getApiKey);
    assert.deepEqual(connection.headers, headers);
    assert.notEqual(connection.headers, headers);
    assert.equal(calls, 0);
  });

  it('does not reuse credentials for a different loopback port, host or API path', () => {
    for (const baseUrl of ['http://127.0.0.1:3426/v1', 'http://localhost:3425/v1', 'http://127.0.0.1:3425/other']) {
      assert.deepEqual(localMagpieConnection({ baseUrl, id: 'other-model', apiKey: 'other-secret' }), { ...LOCAL_MAGPIE, id: '' });
    }
  });
});
