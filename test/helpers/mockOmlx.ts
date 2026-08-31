import { createServer, type Server } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";

export interface MockOmlxRequest {
  path: string;
  body: {
    model?: string;
    messages?: { role: string; content: string; tool_calls?: unknown; tool_call_id?: string }[];
    response_format?: unknown;
    tools?: unknown[];
    chat_template_kwargs?: { enable_thinking?: boolean };
    stream_options?: { include_usage?: boolean };
  };
}

export interface MockOmlx {
  host: string;
  requests: MockOmlxRequest[];
  close(): Promise<void>;
}

export type MockOmlxReply =
  | {
      kind: "content";
      content: string;
      reasoning?: string;
      promptTokens?: number;
      responseTokens?: number;
      /** Stream content, then hold the connection open rather than finishing. */
      hang?: boolean;
    }
  | { kind: "status"; status: number; body: string }
  | { kind: "embed"; vectors: number[][] }
  /** An assistant turn that calls one tool, with a server-assigned id. */
  | { kind: "tools"; id: string; name: string; args: Record<string, unknown> };

export const reply = (content: string): MockOmlxReply => ({ kind: "content", content });

/**
 * Stands in for oMLX's `/v1/chat/completions` and `/v1/embeddings`. Streams
 * SSE frames in two fragments so the aggregation path is exercised the same
 * way `mockOllama` exercises NDJSON aggregation, rather than a single chunk
 * that would pass even if the reassembly logic were wrong.
 */
export async function mockOmlx(replies: MockOmlxReply[]): Promise<MockOmlx> {
  const requests: MockOmlxRequest[] = [];
  const queue = [...replies];

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      requests.push({ path: req.url ?? "", body: raw ? JSON.parse(raw) : {} });

      if ((req.url ?? "").includes("/v1/embeddings")) {
        const next = queue.shift();
        if (next?.kind === "embed") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              data: next.vectors.map((embedding, index) => ({ embedding, index })),
            }),
          );
          return;
        }
      }

      const next = queue.shift();
      if (!next) {
        res.writeHead(500, { "content-type": "text/plain" });
        res.end("mockOmlx: no reply queued");
        return;
      }

      if (next.kind === "status") {
        res.writeHead(next.status, { "content-type": "text/plain" });
        res.end(next.body);
        return;
      }

      if (next.kind === "embed") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: next.vectors.map((embedding, index) => ({ embedding, index })) }));
        return;
      }

      res.writeHead(200, { "content-type": "text/event-stream" });

      if (next.kind === "tools") {
        res.write(
          `data: ${JSON.stringify({
            choices: [
              {
                delta: {
                  tool_calls: [{ index: 0, id: next.id, function: { name: next.name, arguments: "" } }],
                },
              },
            ],
          })}\n\n`,
        );
        res.write(
          `data: ${JSON.stringify({
            choices: [
              { delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(next.args) } }] } },
            ],
          })}\n\n`,
        );
        res.write(`data: ${JSON.stringify({ usage: { prompt_tokens: 5, completion_tokens: 2 } })}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }

      if (next.reasoning) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: next.reasoning } }] })}\n\n`);
      }

      const split = Math.floor(next.content.length / 2);
      for (const part of [next.content.slice(0, split), next.content.slice(split)]) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: part } }] })}\n\n`);
      }
      if (next.hang) return; // Never completed; the caller's deadline decides.
      res.write(
        `data: ${JSON.stringify({
          usage: { prompt_tokens: next.promptTokens ?? 11, completion_tokens: next.responseTokens ?? 7 },
        })}\n\n`,
      );
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;

  return {
    host: `http://127.0.0.1:${port}`,
    requests,
    close: async () => {
      server.close();
      await once(server, "close");
    },
  };
}
