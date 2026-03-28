export default {
  async fetch(request, env) {
    if (request.headers.get("Authorization") !== `Bearer ${env.PROXY_TOKEN}`) {
      return new Response("Unauthorized", { status: 401 });
    }
    const url = new URL(request.url);
    const slug = url.pathname.slice(1);
    if (!slug || !/^[a-z0-9_-]+$/i.test(slug)) {
      return new Response("Usage: /{slug}", { status: 400 });
    }
    const res = await fetch(`https://www.gesetze-im-internet.de/${slug}/xml.zip`, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; openlex-lawsync/1.0)" },
    });
    return new Response(res.body, {
      status: res.status,
      headers: { "Content-Type": res.headers.get("Content-Type") || "application/zip" },
    });
  },
};
