import readline from 'node:readline';
import { DaemonClient } from '../cli/client.ts';
import { TOOLS } from '../tools/catalog.ts';

/**
 * `vf mcp`: a minimal MCP stdio server exposing the same tool catalog as the
 * CLI and the builtin harness. Claude Code, OpenCode and Codex load it from the
 * per-task config the worker manager writes.
 */

interface RpcRequest {
  jsonrpc: '2.0';
  id?: number | string;
  method: string;
  params?: Record<string, unknown>;
}

export async function runMcpServer(): Promise<void> {
  const client = DaemonClient.fromEnv();
  const rl = readline.createInterface({ input: process.stdin });
  const write = (msg: unknown) => process.stdout.write(JSON.stringify(msg) + '\n');

  const handle = async (req: RpcRequest) => {
    if (req.method === 'initialize') {
      return {
        protocolVersion: (req.params?.protocolVersion as string) ?? '2025-06-18',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'vibefox', version: '0.1.0' },
        instructions: 'Tools of an independent AI agent: its browser, inbox, phone, wallet, and the line back to its router.',
      };
    }
    if (req.method === 'ping') return {};
    if (req.method === 'tools/list') {
      return { tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.parameters })) };
    }
    if (req.method === 'tools/call') {
      const name = String(req.params?.name);
      const tool = TOOLS.find((t) => t.name === name);
      if (!tool) return { content: [{ type: 'text', text: `unknown tool ${name}` }], isError: true };
      try {
        const text = await tool.run(client, (req.params?.arguments as Record<string, unknown>) ?? {});
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${(err as Error).message}` }], isError: true };
      }
    }
    throw Object.assign(new Error(`method not found: ${req.method}`), { code: -32601 });
  };

  for await (const line of rl) {
    if (!line.trim()) continue;
    let req: RpcRequest;
    try {
      req = JSON.parse(line);
    } catch {
      write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
      continue;
    }
    if (req.id === undefined) continue; // notification
    // Tools can block (ask/pay/call); don't hold up other requests.
    void handle(req)
      .then((result) => write({ jsonrpc: '2.0', id: req.id, result }))
      .catch((err: Error & { code?: number }) => write({ jsonrpc: '2.0', id: req.id, error: { code: err.code ?? -32603, message: err.message } }));
  }
}
