# Web version (prototype)

The same app, cloud-only, in a browser: `task build:web` (or
`cd frontend && npm run build:web && go build -tags "web server" -o bin/imference-web .`),
then `IMFERENCE_WEB_ADDR=127.0.0.1:8090 bin/imference-web` and sign in with an
imference.com API key.

How it works — one Go codebase, no business logic in TypeScript:

- `web_main.go` / `web_server.go` (build tag `web`): an HTTP server that runs
  **one cloud-only `App` per signed-in user** (own settings, pending cloud jobs
  and gallery under `IMFERENCE_WEB_DATA/users/<id>/`), with the same methods
  the desktop binds.
- The React frontend is built with `--mode web`: Vite aliases
  `@wailsio/runtime` to `src/lib/web-runtime.ts`, so the generated bindings
  keep calling `Call.ByID` (Wails' FNV-32a ID of `main.App.<Method>`) and
  `Events.On` — now over `POST /web/call` and Server-Sent Events
  (`GET /web/events`). `src/lib/target.ts` hides the local-only UI (engine,
  local mode, storage, x402 wallet).
- `web_rpc.go` is the policy: cloud methods are allowed, local status reads
  return empty values, local actions (engine, sidecar, file pickers, wallet,
  local models) answer 501. Settings writes only accept the cloud model; the
  API key is the session's; tools always run in the cloud and refuse file paths.
- Sign-in: `POST /web/login` checks the key against `GET /credits/balance`,
  then sets an `HttpOnly`, `SameSite=Strict` session cookie; every POST also
  needs the `X-Imference-Web: 1` header.

| Env | Default | |
|---|---|---|
| `IMFERENCE_WEB_ADDR` | `127.0.0.1:8090` | listen address |
| `IMFERENCE_WEB_DATA` | `web-data` | per-user data root |
| `IMFERENCE_BASE_URL` | `https://imference.com` | API base |
| `IMFERENCE_WEB_SECURE` | unset | `1` behind HTTPS (Secure cookie) |
| `IMFERENCE_WEB_BASE` | unset | path prefix, e.g. `/app` behind the imference API proxy |
| `IMFERENCE_WEB_GALLERY` | unset (`client`) | `server` keeps generated images on the server instead of the user's disk |

Container: `docker build -f Dockerfile.web -t imference-web .` (Node 22 +
Go 1.25 build stages, distroless non-root runtime, ~28 MB), then
`docker run -p 8090:8090 -v imference-web-data:/data imference-web`. The
frontend uses relative URLs only, so the same image serves `/` or `/app/`
(`IMFERENCE_WEB_BASE=/app`). On imference.com it sits behind the API's `/app`
reverse proxy (`WEB_APP_URL`, see the imference repo README). Base images are
overridable (`--build-arg NODE_IMAGE=... GO_IMAGE=...`) when Docker Hub
rate-limits.

**Deployment (Imference Web).** `.github/workflows/web-deploy.yml` builds
`Dockerfile.web` on every push to `main` and deploys it to the `imference-web`
Azure Container App (internal ingress on `8090`, one replica, env
`IMFERENCE_WEB_BASE=/app` and `IMFERENCE_WEB_SECURE=1`, image pulled with its
system managed identity). It needs these repo secrets:
`IMFERENCE_AZURE_CLIENT_ID`, `IMFERENCE_AZURE_TENANT_ID`,
`IMFERENCE_AZURE_SUBSCRIPTION_ID` (OIDC, with a federated credential for this
repo's `main`; the identity needs push rights on the registry and Contributor on the
Container App), `IMFERENCE_REGISTRY_URL` and `IMFERENCE_RESOURCE_GROUP`. From
Git Bash, pass `/app` to `az` with `MSYS_NO_PATHCONV=1`, or it becomes a
Windows path.

**Gallery on the user's disk (default).** The server never keeps images: a
result comes back to the browser (image + metadata) and
`src/lib/web-gallery.ts` saves it, in the desktop format
(`<YYYYMMDD-HHMMSS>_<source>_<seed>.<ext>` + `.json` sidecar), either in a
folder the user picks (File System Access API: Chrome / Edge / Brave / Opera
desktop; Settings > Gallery) or in the browser's private storage (OPFS, every
browser) — the desktop app can point at the same folder and share the gallery.
`web-runtime.ts` keeps the gallery calls (`ListSavedImages`, `GalleryFacets`,
`GetSavedImage`, `DeleteSavedImage`) in the browser, saves `GenerateCloud` /
`RunTool` results, and sends gallery images to tools as data URIs with their
metadata. Cloud jobs that finish while no tab is open wait in a per-user server
outbox (`TakeClientGalleryOutbox`) until the next visit. `IMFERENCE_WEB_GALLERY=server`
keeps the previous server-side gallery.

**Cloud history.** The gallery's **History** button (and the command palette)
lists every cloud call paid with the API key or the wallet, newest first, from
the API's `GET /history` (`app_history.go`, `internal/cloud/history.go`). The
server keeps the call and its results only, never the prompt or the settings;
a result can be saved to the gallery again (`RedownloadCloudOutput`) for 24 h.
An API key reads its own calls. A wallet signs a Sign-In with Ethereum message
(`personal_sign`, no payment): the desktop with its keychain wallet (a new
sign-in every hour, no prompt), the web with the browser wallet (one prompt a
day, `web:sign` with `purpose: "history"`).

Prototype limits: sessions live in memory (a restart signs everyone out) and
the server is single-instance; the API key is stored in the user's
`settings.json` on the server; no rate limiting. `go test -tags "web server" .` covers the
binding-ID mapping, sign-in/CSRF, the method policy, per-user isolation, the
event stream and a cloud generation end to end against a mock API.
