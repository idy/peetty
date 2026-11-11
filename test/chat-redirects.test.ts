import assert from 'node:assert/strict';
import { createServer, type RequestListener } from 'node:http';
import { describe, it, type TestContext } from 'node:test';
import { ChatRuntime, fetchModelList } from '../src/chat/runtime.ts';
import { MemoryChatStorage } from './helpers/chat-storage.ts';

async function endpoint(t: TestContext, handler: RequestListener): Promise<string> {
  const server = createServer(handler);
  t.after(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}

describe('endpoint redirect boundaries', () => {
  it('never follows model-list redirects with SDK credential headers', async (t) => {
    let destinationRequests = 0;
    const destination = await endpoint(t, (_request, response) => {
      destinationRequests++;
      response.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      response.end(JSON.stringify({ data: [{ id: 'redirected-model' }] }));
    });
    let status = 302;
    let sourceRequests = 0;
    const source = await endpoint(t, (request, response) => {
      sourceRequests++;
      assert.equal(request.headers['x-api-key'], 'discovery-secret');
      request.resume();
      response.writeHead(status, { Location: `${destination}/models`, 'Access-Control-Allow-Origin': '*' });
      response.end();
    });
    for (status of [301, 302, 303, 307, 308]) {
      await assert.rejects(fetchModelList(source, undefined, undefined, { 'x-api-key': 'discovery-secret' }), (error: Error) => {
        assert.match(error.message, /Could not load models/);
        assert.ok(!error.message.includes('discovery-secret'));
        return true;
      });
      assert.equal(destinationRequests, 0);
    }
    assert.equal(sourceRequests, 5);
  });

  it('also keeps chat headers and conversation bodies from following a redirect', async (t) => {
    let destinationRequests = 0;
    const destination = await endpoint(t, (request, response) => {
      destinationRequests++;
      request.resume();
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Access-Control-Allow-Origin': '*' });
      response.end('data: [DONE]\n\n');
    });
    let sourceRequests = 0;
    const source = await endpoint(t, (request, response) => {
      sourceRequests++;
      assert.equal(request.headers['x-api-key'], 'chat-secret');
      request.resume();
      response.writeHead(307, { Location: `${destination}/chat/completions`, 'Access-Control-Allow-Origin': '*' });
      response.end();
    });
    const runtime = new ChatRuntime({
      model: { id: 'model', baseUrl: source, apiKey: 'bearer-secret', headers: { 'x-api-key': 'chat-secret' } },
      chat: { persist: false }, storage: new MemoryChatStorage(),
    });
    t.after(() => runtime.destroy());
    await runtime.send('A private conversation for the configured endpoint.');
    assert.match(runtime.error ?? '', /Could not get a response/);
    assert.equal(sourceRequests, 1);
    assert.equal(destinationRequests, 0);
    assert.ok(!runtime.error!.includes('chat-secret'));
  });
});
