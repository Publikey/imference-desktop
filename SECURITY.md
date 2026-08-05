# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| Latest  | ✅ Yes |
| < Latest | ❌ No (upgrade recommended) |

Imference Desktop ships as a single binary with no back-porting: fixes go into
the next release. The app checks GitHub Releases at startup and shows a banner
when a newer version is available.

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

Instead, please report them privately:

1. **Email:** [contact@imference.com](mailto:contact@imference.com)
2. **GitHub:** Use [private vulnerability reporting](https://github.com/Publikey/imference-desktop/security/advisories/new)

### What to include

- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Affected app version, OS, and GPU vendor (from Settings → the version line at
  the bottom of the dialog)
- Suggested fix (if any)

### Response timeline

- **Acknowledgment:** Within 48 hours
- **Initial assessment:** Within 7 days
- **Fix or mitigation:** Depends on severity, targeting 30 days for critical issues

### What to expect

- We'll acknowledge your report promptly
- We'll work with you to understand and validate the issue
- We'll credit you in the advisory (unless you prefer anonymity)
- We'll coordinate disclosure timing with you

## Scope

This policy covers the desktop app in this repository: the Go application, the
bundled frontend, and the installer/update path.

Two adjacent surfaces are **in scope but reported the same way** (they belong to
the same team):

- The [imference.com](https://imference.com) cloud API the app calls
- The `imference-engine` Python sidecar the installer sets up

Out of scope: vulnerabilities in the upstream model weights, in PyTorch/diffusers
themselves, or in third-party checkpoints you load via "bring your own model" —
report those to their maintainers.

### Known, accepted limitations

These are documented trade-offs, not vulnerabilities — no need to report them:

- **The app is not code-signed yet.** Windows SmartScreen and macOS Gatekeeper
  will warn on first launch. Verify your download against `checksums.txt` from
  the [release](https://github.com/Publikey/imference-desktop/releases/latest).
  Code signing is on the roadmap.
- **No silent auto-update.** The app only notifies and links to the release
  page; it never replaces its own binary.
- **Custom checkpoints are loaded as-is.** A `.safetensors` file you point the
  app at runs through the local engine with your privileges. Only load
  checkpoints from sources you trust.

## Best Practices for Users

- Download only from the
  [official Releases page](https://github.com/Publikey/imference-desktop/releases)
  and check the SHA-256 against `checksums.txt`
- Keep the app up to date — the banner at startup tells you when a release lands
- Treat your imference.com **API key** like a password; rotate it from
  [imference.com/payments](https://imference.com/payments) if it leaks
- For x402, **fund the wallet with only what you intend to spend**. The private
  key lives in your OS keychain, but a burner wallet limits the blast radius —
  export it from Settings if you need to move funds out
- Review a custom checkpoint's source before loading it
