import { createWebChatHandler } from '../server/web-chat-http.mjs';

/** Strip only the exact capture added by vercel.json's public chat rewrite. */
export function createVercelChatHandler(handle = createWebChatHandler()) {
  return async function fetch(request) {
    let forwarded = request;
    try {
      const url = new URL(request.url);
      // Never derive the resource or the origin from a query parameter. Direct
      // /api/chat calls still reach the core handler's NOT_FOUND response.
      if (url.pathname.startsWith('/api/chat/') && url.searchParams.has('path')) {
        const captured = url.searchParams.getAll('path');
        const requested = decodeURIComponent(url.pathname.slice('/api/chat/'.length));
        if (captured.length !== 1 || captured[0] !== requested) throw new Error('INVALID_ROUTE_CAPTURE');
        url.searchParams.delete('path');
        forwarded = new Request(url, request);
      }
    } catch {
      return Response.json({ error: { code: 'INVALID_INPUT' } }, { status: 400, headers: {
        'Cache-Control': 'private, no-store, max-age=0', 'CDN-Cache-Control': 'no-store',
        'Vercel-CDN-Cache-Control': 'no-store', 'Vary': 'Origin, Cookie',
        'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
      } });
    }
    return handle(forwarded);
  };
}

export default { fetch: createVercelChatHandler() };
