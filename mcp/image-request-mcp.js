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
  return {
    tools: [
      {
        name: "request_image",
        description:
          "Queue a local repository image path to be attached on wrapper restart.",
        inputSchema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Relative path to image inside repository root.",
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
  if (request.params.name !== "request_image") {
    throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${request.params.name}`);
  }
  const args = request.params.arguments ?? {};
  const safePath = toSafeRepoRelativePath(args.path);
  fs.mkdirSync(requestsDir, { recursive: true });
  fs.appendFileSync(
    requestsFile,
    `${JSON.stringify({ ts: Date.now(), path: safePath })}\n`,
    "utf8"
  );
  return {
    content: [
      {
        type: "text",
        text: "OK",
      },
    ],
  };
});

const transport = new StdioServerTransport();
await server.connect(transport);
