const ALLOWED_TARGETS = [
  { host: 'opencode.ai', pathPrefix: '/docs/' },
  { host: 'ai.google.dev', pathPrefix: '/gemini-api/docs/' },
];

function isAllowed(target) {
  let parsed;
  try {
    parsed = new URL(target);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  return ALLOWED_TARGETS.some(
    (t) => parsed.hostname === t.host && parsed.pathname.startsWith(t.pathPrefix)
  );
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    const url = new URL(request.url);
    const target = url.searchParams.get('url');

    if (!target) {
      return new Response('Missing "url" parameter', { status: 400 });
    }

    if (!isAllowed(target)) {
      return new Response('Target URL not allowed', { status: 403 });
    }

    const response = await fetch(target, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; DocsProxyBot/1.0)',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });

    const body = await response.text();

    return new Response(body, {
      status: response.status,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'public, max-age=300',
      },
    });
  },
};
