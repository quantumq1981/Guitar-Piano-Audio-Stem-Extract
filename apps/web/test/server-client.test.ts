import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, ServerClient } from '../src/api/server-client.ts';

const ok = { job: { id: 'j' }, upload: { method: 'PUT', url: 'u', headers: {}, expiresAt: '' } };
const req = {} as Parameters<ServerClient['create']>[0];

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('ServerClient.create', () => {
  it('waits through 503s and connection resets while a sleeping host wakes', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('connection reset'))
      .mockResolvedValueOnce(new Response('booting', { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(ok), { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);
    const waits: number[] = [];
    const p = new ServerClient('https://x.hf.space/').create(req, { onWaiting: (n) => waits.push(n) });
    await vi.runAllTimersAsync();
    await expect(p).resolves.toEqual(ok);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(waits).toEqual([1, 2]);
    expect(fetchMock.mock.calls[0]![0]).toBe('https://x.hf.space/v1/jobs');
  });

  it('does not retry client errors', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { code: 'invalid_request', message: 'bad' } }), { status: 422 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(new ServerClient('https://x').create(req)).rejects.toMatchObject({ status: 422, code: 'invalid_request' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('gives up after the wake deadline with a typed error', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 503 })));
    const p = new ServerClient('https://x').create(req, { maxWaitMs: 5000 });
    const assertion = expect(p).rejects.toBeInstanceOf(ApiError);
    await vi.runAllTimersAsync();
    await assertion;
  });
});
