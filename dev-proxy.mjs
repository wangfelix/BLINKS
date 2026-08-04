#!/usr/bin/env node

// Single-origin development proxy.
//
// The free ngrok plan reserves exactly one endpoint, but the phone needs two
// local services: the API server (3000) and the Metro bundler (8081). This
// proxy fronts both on one port so a single `ngrok http` covers them, using the
// same path split Apache applies in production: /api, /frames, /health and the
// /ingest WebSocket belong to the server, everything else belongs to Metro.
//
// Zero dependencies on purpose; it starts before npm install ever matters.

import http from "node:http";
import net from "node:net";

const PORT = Number(process.env.DEV_PROXY_PORT ?? 8090);
const API_PORT = Number(process.env.DEV_PROXY_API_PORT ?? 3000);
const METRO_PORT = Number(process.env.DEV_PROXY_METRO_PORT ?? 8081);
const HOST = "127.0.0.1";

// Server-owned prefixes; Metro owns the rest of the URL space.
const API_PREFIXES = ["/api", "/frames", "/health", "/ingest"];

const resolvePort = (url) => {
  const path = (url ?? "/").split("?")[0];
  const isApi = API_PREFIXES.some(
    (prefix) => path === prefix || path.startsWith(`${prefix}/`),
  );
  return isApi ? API_PORT : METRO_PORT;
};

const server = http.createServer((req, res) => {
  const port = resolvePort(req.url);
  const upstream = http.request(
    { host: HOST, port, path: req.url, method: req.method, headers: req.headers },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    },
  );

  upstream.on("error", (error) => {
    if (!res.headersSent) {
      res.writeHead(502, { "content-type": "text/plain" });
    }
    res.end(`dev-proxy: upstream :${port} unavailable (${error.message})\n`);
  });

  req.pipe(upstream);
});

// WebSocket upgrades: Metro's HMR/inspector channels and the server's /ingest.
server.on("upgrade", (req, socket, head) => {
  const port = resolvePort(req.url);
  const upstream = net.connect(port, HOST, () => {
    let requestHead = `${req.method} ${req.url} HTTP/1.1\r\n`;
    for (let index = 0; index < req.rawHeaders.length; index += 2) {
      requestHead += `${req.rawHeaders[index]}: ${req.rawHeaders[index + 1]}\r\n`;
    }
    upstream.write(`${requestHead}\r\n`);
    if (head?.length) {
      upstream.write(head);
    }
    upstream.pipe(socket);
    socket.pipe(upstream);
  });

  const destroyBoth = () => {
    upstream.destroy();
    socket.destroy();
  };
  upstream.on("error", destroyBoth);
  socket.on("error", destroyBoth);
});

server.listen(PORT, HOST, () => {
  console.log(
    `[dev-proxy] http://${HOST}:${PORT} -> API :${API_PORT} (${API_PREFIXES.join(", ")}), Metro :${METRO_PORT} (everything else)`,
  );
});
