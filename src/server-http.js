/**
 * Always-on Streamable HTTP entry point — for running this MCP server as a
 * boot-time service instead of spawning it per Claude session (stdio, see
 * server.js). Claude Desktop/Code then connects to a URL instead of a
 * `command`, so tool calls hit an already-warm CDP connection to
 * TradingView Desktop and an already-reachable Jetson bridge link instead
 * of paying reconnect cost on every session start.
 *
 * Stateless mode (sessionIdGenerator: undefined): a fresh McpServer +
 * transport per request, per the SDK's documented stateless pattern. This
 * is fine here because the actual expensive state — the CDP client — lives
 * in connection.js as a process-level singleton, not on the McpServer
 * instance, so re-creating the McpServer per request is cheap and call
 * volume is naturally low (a human/agent driving one chart, not a
 * high-throughput API).
 *
 * SECURITY: binds to 127.0.0.1 only — this holds no authentication, so it
 * must never be exposed on a non-loopback interface.
 */
import express from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer } from './serverFactory.js';

const HOST = process.env.TV_MCP_HTTP_HOST || '127.0.0.1';
const PORT = Number(process.env.TV_MCP_HTTP_PORT) || 8787;

if (HOST !== '127.0.0.1' && HOST !== 'localhost') {
  process.stderr.write(`Refusing to bind to non-loopback host "${HOST}" — this server has no auth. Use a reverse proxy with auth in front of it instead.\n`);
  process.exit(1);
}

const app = express();
app.use(express.json({ limit: '10mb' }));

app.post('/mcp', async (req, res) => {
  try {
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => { transport.close(); server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    process.stderr.write(`[tradingview-mcp-http] request error: ${err.stack || err.message}\n`);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: '2.0', id: null, error: { code: -32603, message: 'Internal server error' } });
    }
  }
});

// GET/DELETE on /mcp are part of the Streamable HTTP spec for server-initiated
// streams and session teardown — not used in stateless mode, but respond
// cleanly instead of a bare 404 so well-behaved clients don't warn.
app.get('/mcp', (_req, res) => res.status(405).json({ error: 'This server runs stateless — no server-initiated streams. Send requests via POST.' }));
app.delete('/mcp', (_req, res) => res.status(405).send());

app.get('/healthz', (_req, res) => res.json({ ok: true, service: 'tradingview-mcp-http', pid: process.pid }));

app.listen(PORT, HOST, () => {
  process.stderr.write(`⚠  tradingview-mcp (HTTP)  |  Unofficial tool. Not affiliated with TradingView Inc. or Anthropic.\n`);
  process.stderr.write(`   Listening on http://${HOST}:${PORT}/mcp (loopback only)\n`);
});
