import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createFetcher,
  isPublicAddress,
  publicLookup,
  createPublicLookup,
} from '../backend/fetch.mjs';

test('blocks private, loopback, mapped and reserved addresses before connecting', async () => {
  for (const address of [
    '127.0.0.1',
    '10.1.2.3',
    '169.254.169.254',
    '192.168.0.1',
    '100.64.0.1',
    '::1',
    'fc00::1',
    '::ffff:127.0.0.1',
    '2001:db8::1',
  ])
    assert.equal(isPublicAddress(address), false, address);
  assert.equal(isPublicAddress('1.1.1.1'), true);
  assert.equal(isPublicAddress('2606:4700:4700::1111'), true);
  const fetcher = createFetcher({
    request: () => {
      throw new Error('must not connect');
    },
  });
  try {
    for (const url of [
      'http://127.1',
      'http://[::1]',
      'http://2130706433/',
      'http://localhost/',
      'file:///etc/passwd',
    ])
      await assert.rejects(fetcher.fetch(url), /本机|HTTP/);
    await assert.rejects(
      new Promise((resolve, reject) =>
        publicLookup('localhost', { all: true }, (error, addresses) =>
          error ? reject(error) : resolve(addresses),
        ),
      ),
      /本机/,
    );
  } finally {
    await fetcher.close();
  }
});

test('redirects are checked before each connection', async () => {
  let requests = 0;
  const fetcher = createFetcher({
    request: async () => {
      requests++;
      return new Response(null, {
        status: 302,
        headers: { location: 'http://169.254.169.254/latest/meta-data' },
      });
    },
  });
  try {
    await assert.rejects(fetcher.fetch('https://example.com'), /本机/);
    assert.equal(requests, 1);
  } finally {
    await fetcher.close();
  }
});

test('Fake-IP fallback pins validated public addresses and never permits private DNS answers', async () => {
  let fallbackCalls = 0;
  const resolve = async () => [{ address: '198.18.0.15', family: 4 }];
  const callbackPromise = (lookup) =>
    new Promise((resolve, reject) =>
      lookup('example.com', { all: true }, (error, addresses) =>
        error ? reject(error) : resolve(addresses),
      ),
    );
  const lookup = createPublicLookup({
    resolve,
    fallback: async () => {
      fallbackCalls++;
      return [{ address: '1.1.1.1', family: 4 }];
    },
  });
  assert.deepEqual(await callbackPromise(lookup), [{ address: '1.1.1.1', family: 4 }]);
  assert.equal(fallbackCalls, 1);
  await assert.rejects(
    callbackPromise(createPublicLookup({ resolve, fallbackEnabled: false })),
    /本机/,
  );
  await assert.rejects(
    callbackPromise(
      createPublicLookup({ resolve, fallback: async () => [{ address: '127.0.0.1', family: 4 }] }),
    ),
    /本机/,
  );
  await assert.rejects(
    callbackPromise(
      createPublicLookup({
        resolve: async () => [{ address: '10.0.0.1', family: 4 }],
        fallback: async () => {
          throw new Error('must not run');
        },
      }),
    ),
    /本机/,
  );
});

test('retries transient failures and honors Retry-After, but not permanent failures', async () => {
  let requests = 0;
  const waits = [];
  const fetcher = createFetcher({
    request: async () =>
      ++requests < 3
        ? new Response('', { status: 429, headers: { 'retry-after': '1' } })
        : new Response('成功', { headers: { 'content-type': 'text/plain' } }),
    sleep: async (ms) => waits.push(ms),
  });
  try {
    const page = await fetcher.fetch('https://example.com');
    assert.equal(page.text, '成功');
    assert.equal(requests, 3);
    assert.deepEqual(waits, [1000, 1000]);
  } finally {
    await fetcher.close();
  }
  requests = 0;
  const missing = createFetcher({
    request: async () => {
      requests++;
      return new Response('', { status: 404 });
    },
  });
  try {
    await assert.rejects(missing.fetch('https://example.com'), /404/);
    assert.equal(requests, 1);
  } finally {
    await missing.close();
  }
});

test('caps actual streamed bytes and rejects unsupported response types', async () => {
  const oversized = createFetcher({
    maxBytes: 10,
    request: async () =>
      new Response('a'.repeat(11), { headers: { 'content-type': 'text/plain' } }),
  });
  try {
    await assert.rejects(oversized.fetch('https://example.com'), /上限/);
  } finally {
    await oversized.close();
  }
  const binary = createFetcher({
    request: async () => new Response('binary', { headers: { 'content-type': 'application/pdf' } }),
  });
  try {
    await assert.rejects(binary.fetch('https://example.com'), /内容类型/);
  } finally {
    await binary.close();
  }
});

test('timeout covers a stalled response body and cancellation stops requests', async () => {
  let requests = 0;
  const fetcher = createFetcher({
    timeoutMs: 10,
    attempts: 1,
    request: async (_, { signal }) => {
      requests++;
      return new Response(
        new ReadableStream({
          start(controller) {
            signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
          },
        }),
        { headers: { 'content-type': 'text/plain' } },
      );
    },
  });
  const keepAlive = setInterval(() => {}, 100);
  try {
    await assert.rejects(fetcher.fetch('https://example.com'), { name: 'TimeoutError' });
    await assert.rejects(fetcher.fetch('https://example.com', { signal: AbortSignal.abort() }));
    assert.equal(requests, 1);
  } finally {
    clearInterval(keepAlive);
    await fetcher.close();
  }
});
