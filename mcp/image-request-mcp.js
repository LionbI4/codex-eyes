#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";

const ALLOWED_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const repoRoot = process.cwd();
const requestsDir = path.join(repoRoot, ".codex-eyes");
const requestsFile = path.join(requestsDir, "requests.jsonl");
const LOG_PREFIX = "[codex-eyes-mcp]";

function logEvent(event, details) {
  const timestamp = new Date().toISOString();
  let detailsPart = "";
  if (typeof details !== "undefined") {
    try {
      detailsPart = ` ${JSON.stringify(details)}`;
    } catch {
      detailsPart = " [unserializable-details]";
    }
  }
  process.stderr.write(`${LOG_PREFIX} ${timestamp} ${event}${detailsPart}\n`);
}

function toSafeRepoRelativePath(requestPath) {
  if (typeof requestPath !== "string" || requestPath.trim() === "") {
    throw new McpError(ErrorCode.InvalidParams, "path must be a non-empty string");
  }
  if (path.isAbsolute(requestPath)) {
    throw new McpError(ErrorCode.InvalidParams, "path must be relative to repository root");
  }
  const resolved = path.resolve(repoRoot, requestPath);
  const rootWithSep = repoRoot.endsWith(path.sep) ? repoRoot : `${repoRoot}${path.sep}`;
  if (!(resolved === repoRoot || resolved.startsWith(rootWithSep))) {
    throw new McpError(ErrorCode.InvalidParams, "path traversal is not allowed");
  }
  const ext = path.extname(resolved).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    throw new McpError(
      ErrorCode.InvalidParams,
      "unsupported extension; allowed: .png, .jpg, .jpeg, .webp"
    );
  }
  if (!fs.existsSync(resolved)) {
    throw new McpError(ErrorCode.InvalidParams, `file does not exist: ${requestPath}`);
  }
  const rel = path.relative(repoRoot, resolved).split(path.sep).join("/");
  return rel.startsWith(".") ? rel : `./${rel}`;
}

const server = new Server(
  {
    name: "image-request-mcp",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  logEvent("list_tools");
  return {
    tools: [
      {
        name: "request_image",
        description:
          "For agent use: call this when you need to inspect a local image. It queues the path for codex-eyes, which restarts Codex with 'resume --last -i <path>' so the image is added to context.",
        inputSchema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description:
                "Repository-relative image path (for example './screen.png'). After calling, print <<WAITING_FOR_IMAGE>> and stop until restart.",
            },
          },
          required: ["path"],
          additionalProperties: false,
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const toolName = request.params.name;
  const args = request.params.arguments ?? {};
  logEvent("call_tool", { name: toolName, arguments: args });

  if (toolName !== "request_image") {
    logEvent("unknown_tool", { name: toolName });
    throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${toolName}`);
  }
  const safePath = toSafeRepoRelativePath(args.path);
  fs.mkdirSync(requestsDir, { recursive: true });
  fs.appendFileSync(
    requestsFile,
    `${JSON.stringify({ ts: Date.now(), path: safePath })}\n`,
    "utf8"
  );
  logEvent("queued_request", { path: safePath });
  return {
    content: [
      {
        type: "text",
        text: "Queued. Now print <<WAITING_FOR_IMAGE>> exactly and wait for wrapper restart with image attachment.",
      },
    ],
  };
});

const transport = new StdioServerTransport();
logEvent("server_start", { repoRoot, requestsFile });
await server.connect(transport);
