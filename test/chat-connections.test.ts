import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { connectionIdentity, hasStoredCredentials, isCredentialHeader, LOCAL_MAGPIE, localMagpieConnection, normalizeModelOptions, prepareSavedConnection, sameConnection, toStoredConnection } from '../src/chat/connections.ts';

describe('model tool preference validation', () => {
  it('preserves boolean preferences and leaves the default optional', () => {
    const model = { id: 'model', baseUrl: 'https://api.example' };
    assert.deepEqual(normalizeModelOptions(model), model);
    for (const tools of [true, false]) assert.equal(normalizeModelOptions({ ...model, tools }).tools, tools);
  });

  it('rejects nonboolean preferences without coercion', () => {
    for (const tools of [null, 0, 1, '', 'false', 'true', {}, [], new Boolean(false)]) {
      assert.throws(() => normalizeModelOptions({ id: 'model', baseUrl: 'https://api.example', tools: tools as boolean }), /valid API base URL and model ID/);
    }
  });
});

describe('model reasoning effort validation', () => {
  it('preserves all six explicit levels and omits the default', () => {
    const model = { id: 'model', baseUrl: 'https://api.example' };
    assert.equal('effort' in normalizeModelOptions(model), false);
    for (const effort of ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const) {
      assert.deepEqual(normalizeModelOptions({ ...model, effort }), { ...model, effort });
    }
  });

  it('rejects invalid flags without trimming, case folding, or coercion', () => {
    for (const effort of [null, false, true, 0, 1, '', 'off', 'auto', 'HIGH', ' high ', {}, ['high'], new String('high')]) {
      assert.throws(() => normalizeModelOptions({ id: 'model', baseUrl: 'https://api.example', effort: effort as never }), /valid API base URL and model ID/);
    }
  });
});

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

describe('explicit nonsecret header classification', () => {
  const base = { id: 'model', baseUrl: 'https://api.example/v1', apiKey: 'fixture-static-key' };

  it('canonicalizes, deduplicates and detaches declarations for existing HTTP headers', () => {
    const headers = { 'X-Route': 'fixture-route', 'X-Region': 'fixture-region' };
    const names = ['X-Route', 'x-region', 'x-ROUTE'];
    const model = normalizeModelOptions({ ...base, headers, nonCredentialHeaders: names });
    assert.deepEqual(model.nonCredentialHeaders, ['x-region', 'x-route']);
    names.push('Authorization'); headers['X-Route'] = 'changed';
    assert.deepEqual(model.nonCredentialHeaders, ['x-region', 'x-route']); assert.equal(model.headers!['x-route'], 'fixture-route');
    assert.equal(normalizeModelOptions({ ...base, nonCredentialHeaders: [] }).nonCredentialHeaders, undefined);
    const snapshot = toStoredConnection(model, undefined);
    assert.notEqual(snapshot.nonCredentialHeaders, model.nonCredentialHeaders);
    snapshot.nonCredentialHeaders!.push('other'); assert.deepEqual(model.nonCredentialHeaders, ['x-region', 'x-route']);
  });

  it('rejects malformed declarations and names absent from the supplied header record', () => {
    for (const names of [null, false, 'X-Route', {}, [null], [1], [''], ['bad header'], ['X-Route\r\nAuthorization'], [' X-Route '], ['X-Missing']]) {
      assert.throws(() => normalizeModelOptions({ ...base, headers: { 'X-Route': 'fixture-route' }, nonCredentialHeaders: names as string[] }), { message: 'Enter a valid API base URL and model ID.' });
    }
    assert.throws(() => normalizeModelOptions({ ...base, nonCredentialHeaders: ['X-Route'] }));
  });

  it('accepts explicit metadata tokens that only resemble authentication names', () => {
    for (const name of ['X-Author', 'X-Key-Version', 'X-Tokenization', 'X-Secretariat', 'X-Route', 'X-Subscription-Plan', 'X-Subscription']) {
      const model = normalizeModelOptions({ ...base, headers: { [name]: 'fixture-metadata' }, nonCredentialHeaders: [name] });
      assert.deepEqual(model.nonCredentialHeaders, [name.toLowerCase()]);
      assert.equal(isCredentialHeader(name), true, 'undeclared metadata remains sensitive');
      assert.equal(isCredentialHeader(name, model.nonCredentialHeaders), false);
      assert.equal(prepareSavedConnection(model, undefined, false).headers![name.toLowerCase()], 'fixture-metadata');
    }
  });

  it('accepts explicitly declared numeric token-count metadata without exempting credentials', () => {
    for (const name of ['X-MaxTokens', 'X-InputTokens', 'X-Output-Tokens', 'X-TotalTokens', 'X-PromptTokens', 'X-Completion-Tokens-Limit', 'X-ContextTokens', 'X-RemainingTokens', 'X-UsedTokens', 'X-GenerationTokens', 'X-Token-Count', 'X-Custom-Context-Token-Budget']) {
      for (const value of ['0', '42', '4096']) {
        const model = normalizeModelOptions({ ...base, headers: { [name]: value }, nonCredentialHeaders: [name] });
        assert.equal(isCredentialHeader(name), true, 'undeclared values remain sensitive');
        assert.equal(isCredentialHeader(name, model.nonCredentialHeaders), false);
        const saved = prepareSavedConnection(model, undefined, false);
        assert.deepEqual(saved.headers, { [name.toLowerCase()]: value });
        assert.equal(saved.apiKey, undefined);
        assert.equal(hasStoredCredentials(saved), false);
      }
      for (const value of ['synthetic-secret', 'NaN', 'Infinity', '-1', '1.5', '9007199254740993']) {
        assert.throws(() => normalizeModelOptions({ ...base, headers: { [name]: value }, nonCredentialHeaders: [name] }));
      }
    }
    for (const name of ['X-ClientToken', 'X-AuthToken', 'X-Token', 'X-InputTokensSecret', 'X-AccessTokens', 'X-Refresh-Tokens', 'X-ClientTokensCount', 'X-AuthTokensLimit', 'X-SecretTokensBudget']) {
      assert.throws(() => normalizeModelOptions({ ...base, headers: { [name]: '42' }, nonCredentialHeaders: [name] }));
    }
  });

  it('never permits authentication names to be exempted', () => {
    for (const name of ['Authorization', 'Proxy-Authorization', 'Api-Key', 'X-Api-Key', 'X-Auth', 'X-Access-Key', 'X-Token', 'X-Secret', 'Cookie', 'Set-Cookie', 'Ocp-Apim-Subscription-Key', 'X-Key', 'Gateway-Credential', 'X-Password', 'X-Authentication', 'X-AccessToken', 'X-AuthToken', 'x-AUTHTOKEN', 'X-Auth-Token', 'X-SecretKey', 'x-secretkey', 'X-Secret-Key', 'X-APIKEY', 'X-SubscriptionKey', 'X-Subscription-Token']) {
      assert.throws(() => normalizeModelOptions({ ...base, headers: { [name]: 'fixture-sensitive' }, nonCredentialHeaders: [name] }));
      assert.equal(isCredentialHeader(name, [name]), true);
    }
  });

  it('keeps prefixed and compound secret-bearing names sensitive', () => {
    for (const prefix of ['Client', 'Auth', 'Session', 'Gateway', 'Service', 'Private', 'Refresh']) {
      for (const suffix of ['Secret', 'SecretKey', 'Token', 'Credential', 'Password', 'Cookie']) {
        const name = `X-${prefix}${suffix}`;
        assert.throws(() => normalizeModelOptions({ ...base, headers: { [name]: 'synthetic-compound-secret' }, nonCredentialHeaders: [name] }));
        assert.equal(isCredentialHeader(name, [name]), true);
        const connection = { ...base, headers: { [name]: 'synthetic-compound-secret' } };
        assert.equal(prepareSavedConnection(connection, connection, false).headers, undefined);
        assert.equal(hasStoredCredentials({ ...connection, apiKey: '' }), true);
      }
    }
  });

  it('opts newly declared routing metadata into persistence without key consent', () => {
    const chosen = normalizeModelOptions({ ...base, headers: { 'X-Route': 'fixture-route', 'X-Undeclared': 'fixture-sensitive' }, nonCredentialHeaders: ['X-Route'] });
    const saved = prepareSavedConnection(toStoredConnection(chosen, chosen.apiKey), undefined, false);
    assert.deepEqual(saved.headers, { 'x-route': 'fixture-route' });
    assert.deepEqual(saved.nonCredentialHeaders, ['x-route']); assert.equal(saved.apiKey, undefined);
    assert.equal(hasStoredCredentials(saved), false);
    assert.equal(hasStoredCredentials(chosen), true, 'the API key and undeclared header remain sensitive');
    assert.equal(isCredentialHeader('X-Route'), true); assert.equal(isCredentialHeader('X-Route', ['x-route']), false);
    const { nonCredentialHeaders: _names, ...old } = chosen;
    assert.equal(prepareSavedConnection(old, old, false).headers, undefined, 'old data without a marker remains conservative');
    assert.equal(hasStoredCredentials({ ...saved, headers: { 'x-route': 'fixture-route', 'x-undeclared': 'fixture-sensitive' } }), true);
  });

  it('includes canonical classifications in identity and retains copied local gateway declarations', () => {
    const first = { ...base, headers: { 'X-Route': 'fixture-route', 'X-Region': 'fixture-region' }, nonCredentialHeaders: ['X-Route', 'x-region'] };
    const equivalent = { ...first, nonCredentialHeaders: ['X-REGION', 'x-route', 'X-Route'] };
    assert.equal(connectionIdentity(first), connectionIdentity(equivalent)); assert.equal(sameConnection(first, equivalent), true);
    assert.notEqual(connectionIdentity(first), connectionIdentity({ ...first, nonCredentialHeaders: ['x-route'] }));
    assert.equal(sameConnection(first, { ...first, nonCredentialHeaders: [] }), false);
    const local = localMagpieConnection({ ...first, ...LOCAL_MAGPIE });
    assert.deepEqual(local.nonCredentialHeaders, first.nonCredentialHeaders); assert.notEqual(local.nonCredentialHeaders, first.nonCredentialHeaders);
  });
});

describe('shared connection projections', () => {
  const base = { id: 'model', baseUrl: 'https://api.example/v1', apiKey: 'fixture-connection-key' };

  it('projects only transport data using the explicitly selected key', () => {
    let calls = 0;
    const model = { ...base, provider: 'Provider', headers: { 'openai-project': 'project' }, tools: false, effort: 'high' as const,
      getApiKey: () => { calls++; return 'must-not-be-resolved'; }, privateContext: { extra: true } };
    const snapshot = toStoredConnection(model, undefined);
    assert.deepEqual(snapshot, { id: base.id, baseUrl: base.baseUrl, provider: 'Provider', headers: { 'openai-project': 'project' }, tools: false, effort: 'high' });
    assert.equal(calls, 0);
    assert.notEqual(snapshot.headers, model.headers);
    snapshot.headers!['openai-project'] = 'changed';
    assert.equal(model.headers['openai-project'], 'project');
    assert.equal(toStoredConnection(model, 'selected-key').apiKey, 'selected-key');
    assert.equal(toStoredConnection(model, '').apiKey, '', 'explicit keyless values retain their representation');
  });

  it('applies credential lifetime without dropping owned provider headers or retaining new SDK headers', () => {
    const known = { ...base, headers: { Authorization: 'Bearer old', 'OpenAI-Project': 'project' } };
    const chosen = { ...base, headers: { 'openai-project': 'project', 'x-sdk-only': 'not-owned' } };
    const retained = prepareSavedConnection(chosen, known, true);
    assert.deepEqual(retained.headers, { 'openai-project': 'project' });
    assert.equal(retained.apiKey, base.apiKey);
    const forgotten = prepareSavedConnection(known, known, false);
    assert.deepEqual(forgotten.headers, { 'openai-project': 'project' });
    assert.equal(forgotten.apiKey, undefined);
    assert.equal(prepareSavedConnection({ ...chosen, baseUrl: 'https://another.example/v1' }, known).headers, undefined);
    assert.deepEqual(known.headers, { Authorization: 'Bearer old', 'OpenAI-Project': 'project' });
  });

  it('treats arbitrary unclassified headers as credentials while retaining documented metadata on opt-out', () => {
    const { apiKey: _key, ...keyless } = base;
    const metadata = { 'OpenAI-Organization': 'org', 'OpenAI-Project': 'project', 'OpenAI-Beta': 'feature',
      'Anthropic-Version': '2023-06-01', 'Anthropic-Beta': 'feature', 'Anthropic-Dangerous-Direct-Browser-Access': 'true',
      Accept: 'application/json', 'Content-Type': 'application/json', 'HTTP-Referer': 'https://app.example', 'X-Title': 'My app' };
    const credentials = { 'X-Auth': 'auth', 'X-Access-Key': 'access', 'Gateway-Pass': 'arbitrary', 'X-Version': 'unclassified', Cookie: 'cookie' };
    const known = { ...base, headers: { ...metadata, ...credentials } };
    assert.deepEqual(prepareSavedConnection(known, known, false).headers, Object.fromEntries(new Headers(metadata)));
    assert.deepEqual(prepareSavedConnection(known, known, true).headers, Object.fromEntries(new Headers(known.headers)));
    for (const name of Object.keys(credentials)) {
      assert.equal(isCredentialHeader(name), true);
      assert.equal(hasStoredCredentials({ ...keyless, headers: { [name]: 'value' } }), true);
    }
    assert.equal(hasStoredCredentials({ ...keyless, headers: metadata }), false);
    assert.equal(hasStoredCredentials({ ...keyless, headers: { 'X-Auth': '  ' } }), false);
  });

  it('uses the same effective identity for comparison and session deduplication', () => {
    const first = { ...base, headers: { Authorization: 'Bearer token', 'OpenAI-Project': 'project' } };
    const equivalent = { ...base, id: ' model ', baseUrl: `${base.baseUrl}/chat/completions`, tools: true,
      headers: { 'openai-project': ' project ', authorization: 'Bearer token' } };
    assert.equal(connectionIdentity(first), connectionIdentity(equivalent));
    assert.equal(sameConnection(first, equivalent), true);
    assert.equal(sameConnection(first, { ...equivalent, effort: 'high' }), false);
    assert.notEqual(connectionIdentity(first), connectionIdentity({ ...first, apiKey: 'rotated' }));
    let calls = 0;
    assert.equal(sameConnection(first, { ...first, getApiKey: () => { calls++; return base.apiKey; } }), false);
    assert.equal(calls, 0);
    assert.equal(sameConnection(first, { ...first, baseUrl: 'invalid' }), false);
    const invalidEffort = { ...first, effort: NaN as never };
    assert.equal(sameConnection(invalidEffort, invalidEffort), false);
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
