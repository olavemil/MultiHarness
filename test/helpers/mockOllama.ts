import { createServer, type Server } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";

export interface MockRequest {
  path: string;
  body: {
    model?: string;
    messages?: { role: string; content: string }[];
    format?: unknown;
    tools?: unknown[];
    options?: Record<string, unknown>;
    keep_alive?: unknown;
    think?: unknown;
  };
}

export interface MockOllama {
  host: string;
  /** Every request received, in order. */
  requests: MockRequest[];
  close(): Promise<void>;
}

export type MockReply =
  | {
      kind: "content";
      content: string;
      /** Streamed on `message.thinking`, as a reasoning model does. */
      thinking?: string;
      promptTokens?: number;
      responseTokens?: number;
      /**
       * Stream the content and then hold the connection open instead of
       * finishing. Reproduces the real timeout shape: a step that has written
       * most of its answer when the deadline fires, which is what makes
       * salvaging worth doing at all.
       */
      hang?: boolean;
    }
  | { kind: "status"; status: number; body: string }
  /** `/api/embed` answers with plain JSON, not the NDJSON stream. */
  | { kind: "embed"; vector: number[] }
  /** An agent turn that asks for tools instead of answering. */
  | { kind: "tools"; calls: { name: string; args: Record<string, unknown> }[] };

/** Convenience: a successful reply carrying `content`. */
export const reply = (content: string): MockReply => ({ kind: "content", content });

/** Convenience: a turn that calls one tool. */
export const toolCall = (name: string, args: Record<string, unknown> = {}): MockReply => ({
  kind: "tools",
  calls: [{ name, args }],
});

/** Convenience: an embedding response for `/api/embed`. */
export const embedding = (vector: number[]): MockReply => ({ kind: "embed", vector });

/**
 * Stands in for ollama's `/api/chat`, serving `replies` in order. Streams the
 * content in two fragments so the NDJSON aggregation path is exercised rather
 * than bypassed by a single-chunk response.
 */
export interface MockOllamaOptions {
  /**
   * Hold each request this long before answering.
   *
   * Needed wherever a test is about *overlap*: an instantly-answering server
   * lets two "concurrent" calls finish before either could have queued, so a
   * lease test against it measures nothing and passes anyway.
   */
  delayMs?: number;
}

export async function mockOllama(
  replies: MockReply[],
  options: MockOllamaOptions = {},
): Promise<MockOllama> {
  const requests: MockRequest[] = [];
  const queue = [...replies];

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", async () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      requests.push({ path: req.url ?? "", body: raw ? JSON.parse(raw) : {} });
      if (options.delayMs) await new Promise((done) => setTimeout(done, options.delayMs));

      const next = queue.shift();
      if (!next) {
        res.writeHead(500, { "content-type": "text/plain" });
        res.end("mockOllama: no reply queued");
        return;
      }

      if (next.kind === "embed") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ embeddings: [next.vector] }));
        return;
      }

      if (next.kind === "tools") {
        res.writeHead(200, { "content-type": "application/x-ndjson" });
        res.write(
          `${JSON.stringify({
            message: {
              content: "",
              tool_calls: next.calls.map((c) => ({
                function: { name: c.name, arguments: c.args },
              })),
            },
            done: false,
          })}\n`,
        );
        res.write(`${JSON.stringify({ done: true, prompt_eval_count: 5, eval_count: 2 })}\n`);
        res.end();
        return;
      }

      if (next.kind === "status") {
        res.writeHead(next.status, { "content-type": "text/plain" });
        res.end(next.body);
        return;
      }

      res.writeHead(200, { "content-type": "application/x-ndjson" });

      // Reasoning arrives first, on its own field, contributing nothing to
      // `content` and nothing to eval_count.
      if (next.thinking) {
        res.write(
          `${JSON.stringify({ message: { content: "", thinking: next.thinking }, done: false })}\n`,
        );
      }

      const split = Math.floor(next.content.length / 2);
      for (const part of [next.content.slice(0, split), next.content.slice(split)]) {
        res.write(`${JSON.stringify({ message: { content: part }, done: false })}\n`);
      }
      if (next.hang) return; // Never completed; the caller's deadline decides.
      res.write(
        `${JSON.stringify({
          done: true,
          prompt_eval_count: next.promptTokens ?? 11,
          eval_count: next.responseTokens ?? 7,
        })}\n`,
      );
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
