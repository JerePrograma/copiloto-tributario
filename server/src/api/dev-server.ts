import http from "node:http";
import { parse } from "node:url";
import { chat } from "./chat";
import { search } from "./search";
import { env } from "../lib/env";

const argv = process.argv.slice(2);
const pFlag = argv.findIndex((arg) => arg === "-p" || arg === "--port");
const cliPort = pFlag >= 0 ? Number(argv[pFlag + 1]) : undefined;
const PORT = env.PORT ?? cliPort ?? 3001;

const server = http.createServer((req, res) => {
  const { pathname } = parse(req.url ?? "", true);
  res.setHeader("Access-Control-Allow-Origin", env.FRONTEND_ORIGIN ?? "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === "GET" && pathname === "/api/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (pathname === "/api/chat" && req.method === "POST") {
    void chat(req, res);
    return;
  }

  if (pathname === "/api/search" && req.method === "POST") {
    void search(req, res);
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found" }));
});

server.listen(PORT, () => {
  console.log(`dev-server http://localhost:${PORT}`);
});
