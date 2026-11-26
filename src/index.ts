import { deriveCode, renderSvg } from "./lib/identicon";

type WorkerEnvironment = {
  MZM_IDENTICON_RELEASE_SHA?: string;
};

const SVG_HEADERS: Record<string, string> = {
  "Cache-Control": "public, max-age=31536000, immutable",
  "Content-Type": "image/svg+xml; charset=utf-8",
  "X-Content-Type-Options": "nosniff",
};

function text(status: number, body: string, extraHeaders: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
      ...extraHeaders,
    },
  });
}

function releaseHeader(env: WorkerEnvironment): Record<string, string> {
  const sha = env.MZM_IDENTICON_RELEASE_SHA;
  return sha && /^[a-f0-9]{40}$/.test(sha) ? { "X-Mzm-Identicon-Release": sha } : {};
}

export default {
  async fetch(request: Request, env: WorkerEnvironment = {}, _ctx?: unknown): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "GET" && request.method !== "HEAD") {
      return text(405, "Method Not Allowed", { Allow: "GET, HEAD" });
    }
    if (url.pathname === "/") {
      return text(200, "identicon", releaseHeader(env));
    }
    if (url.pathname === "/api/identicon/" || url.pathname === "/api/identicon") {
      return text(400, "Bad Request");
    }
    const match = url.pathname.match(/^\/api\/identicon\/([^/]+)\/?$/);
    if (match) {
      let id: string;
      try {
        id = decodeURIComponent(match[1]);
      } catch {
        return text(400, "Bad Request");
      }
      if (!id) {
        return text(400, "Bad Request");
      }
      const svg = await renderSvg(id, 150);
      return new Response(request.method === "HEAD" ? null : svg, {
        status: 200,
        headers: { ...SVG_HEADERS, "Content-Length": String(new TextEncoder().encode(svg).length) },
      });
    }
    return text(404, "Not Found");
  },
};

export { deriveCode, renderSvg };
