# AI agents and the local API

Imference Desktop can be driven by an AI agent through the open-source
[Imference MCP server](https://github.com/Publikey/Imference-mcp) — ask Claude
for an image and your own GPU makes it.

1. Open **Settings → AI agents** (or click **AI agents** in the header).
2. Click **Connect** next to Claude Desktop or Claude Code. Desktop looks at
   what's already there (an MCP server set up before, an npm install, a
   Node.js ≥ 20.10) and downloads only what's missing: the server
   (`imference-mcp.js`, from the MCP's GitHub release) and, if no usable
   Node.js is found, the official portable Node.js — both checked against
   their published SHA-256. For any other MCP app, **Show setup** gives the
   config snippet to paste.
3. Restart the AI app and ask: *"Generate a lighthouse in a storm with
   Imference."*

What the agent can do, and how it shows:

- **Generate locally, for free**, with the models you downloaded (a
  downloaded model that isn't loaded is loaded first; an agent never starts a
  multi-GB download), and run the **editing tools** on your machine.
- **Everything is visible**: each run appears live in Activity, marked
  *via Claude* (or the app's name) with its model, and lands in the gallery —
  including the agent's cloud runs.
- **Cloud only if you allow it**: *Let AI agents spend my credits for cloud
  runs* (off by default) lets the MCP server use this app's Imference account
  for cloud runs. The key is handed out on request and never written into the
  agent's config; turning the option off stops it at once.
- **Your call**: *Let AI agents use Imference Desktop* turns the whole local
  API off. A local failure is reported to the agent, never silently retried
  as a paid cloud run.

The local API behind it is described below.

## The local API

While the app is open it serves a local API on
`127.0.0.1` (port 47823 when free) protected by a random token, so agents —
e.g. the Imference MCP server with `run_on: local` — can run tools on your
machine for free. The port and token are in
`<config dir>/imference-desktop-go/local-api.json` (`{"port","token","pid"}`,
readable only by you, removed when the app quits):

```bash
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:47823/v1/tools
curl -H "Authorization: Bearer $TOKEN" -X POST http://127.0.0.1:47823/v1/tools/upscale \
     -d '{"inputs": {"image": "/path/to/in.png"}, "params": {"scale": 2}}'
# with an edit model loaded: references is a list (up to 2)
curl -H "Authorization: Bearer $TOKEN" -X POST http://127.0.0.1:47823/v1/tools/instruct-edit \
     -d '{"inputs": {"image": "/path/in.png", "references": ["/path/hat.png"]},
          "params": {"instruction": "put the hat from image 2 on the cat"}}'
```

Inputs may be absolute paths, `https://` URLs or `data:` URIs; outputs are
saved to the gallery and returned as paths. Runs are local only (`503
unsupported_runtime` when this machine can't run the tool). Turn the API off
in Settings → *AI agents*.

Agents can also **generate** with your GPU (the MCP server's `generate` with
`run_on: local`):

```bash
# the loaded model, the local models and which are downloaded
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:47823/v1/generation
curl -H "Authorization: Bearer $TOKEN" -X POST http://127.0.0.1:47823/v1/generate \
     -d '{"prompt": "a red fox in fresh snow", "format_code": "portrait"}'
```

Empty fields take the model's defaults (format, steps, guidance, quality
tags). A `model` other than the loaded one is loaded first when it is already
downloaded (`400 model_not_cached` otherwise: agents never start a download);
the engine starts on demand (`503 engine_not_ready` when it isn't installed).
`source_image` + `strength` run image-to-image.

Runs started this way show up live in Activity ("via Claude" — the MCP
server sends its client's name as `X-Imference-Agent`) and land in the
gallery.

## What "Connect" does

One click wires the
[Imference MCP server](https://github.com/Publikey/Imference-mcp) into
Claude Desktop (its `claude_desktop_config.json`, merged, `.bak` first) or
Claude Code (`claude mcp add -s user`), or shows the snippet for any other
MCP app. Desktop first looks at what's there — servers already configured
(and whether they start), an npm install, a Node.js ≥ 20.10 — and only
downloads what's missing: the single-file server `imference-mcp.js` from the
MCP's GitHub release, and the official portable Node.js when none fits, both
sha256-checked, into `<config dir>/imference-desktop-go/mcp/`. The client
config points at them with absolute paths. Your API key is only added when
you tick the option (cloud runs then spend your credits).
