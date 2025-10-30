import http from "node:http";
import { parse } from "node:url";
const argv = process.argv.slice(2);
const pFlag = argv.findIndex((a) => a === "-p" || a === "--port");
const cliPort = pFlag >= 0 ? Number(argv[pFlag + 1]) : undefined;
const PORT = Number(process.env.PORT ?? cliPort ?? 3000);
const server = http.createServer((req, res) => {
  const { pathname } = parse(req.url || "", true);
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }
  if (req.method === "GET" && pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (req.method === "POST" && pathname === "/api/chat") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    });
    const send = (e: string, d: unknown) =>
      res.write(`event: ${e}\ndata: ${JSON.stringify(d)}\n\n`);
    send("ready", { ttfb_ms: 0 });
    send("token", { text: "Hola " });
    setTimeout(() => send("token", { text: "mundo" }), 200);
    setTimeout(() => {
      send("done", {});
      res.end();
    }, 400);
    req.on("close", () => res.end());
    return;
  }
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found" }));
});
server.listen(PORT, () => console.log(`dev-server http://localhost:${PORT}`));
