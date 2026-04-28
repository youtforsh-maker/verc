export const config = { runtime: "edge" };

const TARGET_BASE = (process.env.TARGET_DOMAIN || "").replace(/\/$/, "");

const STRIP_HEADERS = new Set([
  "host",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",       // non-standard but real; must not reach upstream
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "forwarded",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-forwarded-port",
]);

export default async function handler(req) {
  if (!TARGET_BASE)
    return new Response("Misconfigured: TARGET_DOMAIN is not set", { status: 500 });

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 23_000);

  try {
    const pathStart = req.url.indexOf("/", 8);
    const targetUrl =
      pathStart === -1 ? TARGET_BASE + "/" : TARGET_BASE + req.url.slice(pathStart);

    const out = new Headers();
    let clientIp = null;
    for (const [k, v] of req.headers) {
      if (STRIP_HEADERS.has(k)) continue;
      if (k.startsWith("x-vercel-")) continue;
      if (k === "x-real-ip") { clientIp = v; continue; }
      if (k === "x-forwarded-for") { if (!clientIp) clientIp = v; continue; }
      out.set(k, v);
    }
    if (clientIp) out.set("x-forwarded-for", clientIp);

    const method = req.method;
    const hasBody = method !== "GET" && method !== "HEAD";

    const upstream = await fetch(targetUrl, {
      method,
      headers: out,
      body: hasBody ? req.body : undefined,
      duplex: "half",
      redirect: "manual",
      signal: ac.signal,
    });

    clearTimeout(timer);

    // Inject cache-control to prevent Vercel's CDN from caching XHTTP GET
    // download-channel responses. Xray does not set this header by default,
    // and a cached streaming response would corrupt the download channel.
    const resHeaders = new Headers(upstream.headers);
    resHeaders.set("cache-control", "no-store");

    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: resHeaders,
    });

  } catch (err) {
    clearTimeout(timer);
    const isTimeout = err?.name === "AbortError";
    console.error("relay error:", err);
    return new Response(
      isTimeout ? "Gateway Timeout: Origin did not respond" : "Bad Gateway: Tunnel Failed",
      { status: isTimeout ? 504 : 502 }
    );
  }
}
