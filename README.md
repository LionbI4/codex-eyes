# Codex Eyes (Wrapper + MCP)

Autonomous local image attachment for **Codex CLI**.

This project makes Codex capable of **deciding on its own** that it needs to look at a local image and then continuing its work **with that image attached**, without manual `-i` copy-paste.

---

## Why this exists

Codex CLI can accept images via:

```bash
codex -i ./path/to/image.png
```

…but this normally requires **manual user action**.

Claude Code feels autonomous because it has built-in “eyes” (tools that can read images). Codex does not — but it *can be made autonomous* using a thin wrapper + MCP.

This project provides exactly that.

---

## High-level idea

Codex **cannot** dynamically attach images mid-session.

However, it **can**:

* restore conversation state via `resume --last`
* accept images at startup via `-i`

So we build a loop where:

1. Codex decides it needs an image
2. Codex requests that image via MCP
3. A wrapper restarts Codex with `resume --last -i <image>`
4. The wrapper nudges Codex to continue

From Codex’s perspective, it simply:

> “asked for eyes → got eyes → continued thinking”

---

## Exact execution flow

### Step-by-step

1. **Codex is running** inside the wrapper (interactive TTY).

2. Codex decides it needs to see an image and calls an MCP tool:

```text
request_image({ path: "./screens/error.png" })
```

3. The MCP server:

* validates the path (repo-scoped)
* writes a request entry to:

```text
.codex-eyes/requests.jsonl
```

4. Codex prints a pause marker and stops:

```text
<<WAITING_FOR_IMAGE>>
```

5. The wrapper detects this marker in stdout.

6. The wrapper:

* reads the last image request
* kills the current Codex process
* restarts Codex using:

```bash
codex resume --last -i ./screens/error.png
```

7. After startup, the wrapper **automatically sends** to stdin:

```text
Requested image attached
```

8. Codex resumes work with the image now present in context.

---

## Why a restart is required

Codex CLI only accepts images **at process start**.

There is currently no supported way to attach a new image to an already-running Codex session.

Restarting with `resume --last` is the only reliable mechanism.

---

## State machine (FSM)

```text
RUNNING
  │
  ├─ Codex calls request_image(path)
  ▼
NEED_IMAGE
  │
  ├─ Codex prints <<WAITING_FOR_IMAGE>>
  ▼
RESTARTING
  │
  ├─ kill Codex process
  ▼
RESUMING
  │
  ├─ codex resume --last -i <image>
  ▼
NUDGING
  │
  ├─ send "Requested image attached" message
  ▼
RUNNING
```

Failure paths lead to **ERROR** (invalid path, missing file, too many restarts).

---

## Security model

* Images are allowed **only inside the repository root**
* Paths are resolved relative to the directory where the wrapper is launched
* `..` path traversal is rejected
* Optional extension allowlist: `.png`, `.jpg`, `.jpeg`, `.webp`

This prevents Codex from accessing arbitrary files on the system.

---

## Project structure

```text
.
├── wrapper/
│   └── codex-eyes.js          # PTY wrapper (restart + resume)
├── mcp/
│   └── image-request-mcp.js   # MCP stdio server
└── .codex-eyes/
    └── requests.jsonl         # image request queue
```

---

## Requirements

* Node.js 18+
* Codex CLI available as `codex` in PATH

---

## Install globally (use in any folder)

From this repository:

```bash
npm install
npm link
```

After that, these commands are available globally:

```bash
codex-eyes
codex-eyes-mcp
```

`codex-eyes` uses your current working directory as repo root, so you can run it from any project folder.

### Alternative without `npm link` (local package artifact)

```bash
npm pack
npm install -g ./codfix-0.1.0.tgz
```

### Verify global commands are on PATH

```bash
codex-eyes --version
codex-eyes-mcp --version
```

If `codex-eyes-mcp --version` is not implemented in your shell, run:

```bash
where codex-eyes-mcp   # Windows
which codex-eyes-mcp   # macOS/Linux
```

---

## Configure local MCP server in Codex

This project uses a **local stdio MCP server**. The most reliable setup is to register it once in your user config.

### Recommended (CLI-managed)

```bash
codex mcp add codex_eyes -- codex-eyes-mcp
```

Verify:

```bash
codex mcp list
codex mcp get codex_eyes
```

### Manual `config.toml` (equivalent)

Config file location:

* Windows: `%USERPROFILE%\\.codex\\config.toml`
* macOS/Linux: `~/.codex/config.toml`

Add:

```toml
[mcp_servers.codex_eyes]
transport = "stdio"
command = "codex-eyes-mcp"
args = []
```

If you prefer a fixed Node path + script path:

```toml
[mcp_servers.codex_eyes]
transport = "stdio"
command = "node"
args = ["C:/nvm4w/nodejs/node_modules/codfix/mcp/image-request-mcp.js"]
```

Important: `args` must be a TOML array, not a single string.

---

## Run from anywhere

1. Open any project folder in terminal.
2. Start wrapper:

```bash
codex-eyes
```

3. In Codex, when image inspection is needed, call MCP tool:

```text
request_image({ path: "./screen.png" })
```

`codex-eyes` will restart Codex with image attachment and continue automatically.

---

## MCP tool contract

### Tool name

```text
request_image(path: string)
```

### Behavior

* Path must be relative to repo root
* MCP writes a JSON line:

```json
{"ts":1730000000000,"path":"./screens/error.png"}
```

* Tool returns an ACK text only

The wrapper is responsible for actually attaching the image.

---

## Codex system prompt contract (CRITICAL)

Codex must follow these rules:

1. If you need to see a local image, call the MCP tool:

```text
request_image({ path: "..." })
```

2. Immediately after the tool call, print **exactly**:

```text
<<WAITING_FOR_IMAGE>>
```

3. Stop. Do not guess what is in the image.
4. Resume only after the image is attached.

Without this contract, autonomous behavior is impossible.

---

## Example interaction

User:

> Analyze the UI screenshot in `./screens/login_error.png`

Codex:

* calls `request_image({ path: "./screens/login_error.png" })`
* prints `<<WAITING_FOR_IMAGE>>`

Wrapper:

* restarts Codex with `resume --last -i ./screens/login_error.png`
* sends `Requested image attached` message

Codex:

* resumes reasoning
* analyzes the image

---

## Limitations

* Restart is unavoidable (CLI limitation)
* `resume --last` restores context, not execution — nudging is mandatory
* Infinite restart loops must be rate-limited

---

## Why this works

* Codex remains the decision-maker
* The wrapper acts as a deterministic tool executor
* No guessing, no manual image feeding

This turns Codex CLI into a **true autonomous agent with vision**.
