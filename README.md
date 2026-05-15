<p align="center">
  <img height="300px" src="docs/png/banner.png" />
</p>

# 🤖💵 Agentic Payment Service for Open Agent Skills Ecosystem.

> A tri-protocol (x402 + AP2 + MPP) agentic payment service for Open Agent Skills Ecosystem (including OpenClaw, Claude Code, Codex, Junie, OpenCode, GitHub Copilot, Gemini CLI, etc.),
> with web3 & web2 gateway support, EIP-3009 signed stablecoin authorizations (Viem), AWS KMS key management, policy engine compliance, audit trail, and human-in-the-loop confirmation.

[![TypeScript](https://img.shields.io/badge/TypeScript-5.7+-blue.svg)](https://www.typescriptlang.org/)
[![OpenClaw Skill](https://img.shields.io/badge/OpenClaw-Skill-ff6b35.svg)](https://openclaw.ai)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-green.svg)](LICENSE)

---

## Table of Contents

- [Overview](#overview)
- [Architecture](#architecture)
  - [System Diagram](#system-diagram)
  - [Directory Structure](#directory-structure)
  - [Data Flow](#data-flow)
- [Quick Start with Docker and Docker Compose](#quick-start)
- [Documentation](#documentation)
- [License](#license)

---
## Overview

**agentic-payments-bot** is a payment serivce/gateway/bot/agent/assistant with support for and providing of X402, AP2, and MPP server and client, and providing
an Open Agent Skills Ecosystem compliant skill, that enables AI agents to autonomously initiate, validate, and execute payments
across both blockchain (web3) and traditional (web2) payment rails.

### Key Capabilities

| Capability | Details |
|---|---|
| **Triple protocol support** | x402 (HTTP 402 + onchain settlement), AP2 (Google's mandate-based agent payments), and MPP (Machine Payments Protocol — rail-agnostic quote → invoice → settle → receipt lifecycle with content-addressed invoices and signed receipts) |
| **Dual role: server + client** | Acts as a **payment gateway** (accepts payments from external agents via x402/AP2/MPP server endpoints) and as a **payment client** (makes payments to external services via all backends) |
| **Web3 transactions** | Ethereum, Base, Polygon via [Viem](https://viem.sh) — native ETH and ERC-20 (USDC, etc.) |
| **EIP-3009 signing** | Full x402 client payment flow: EIP-712 `TransferWithAuthorization` signed via Viem with a private key decrypted through the configured KMS backend — the key never leaves the KMS trust boundary |
| **Web2 gateways** | Stripe, PayPal, Visa Direct, Mastercard Send, Google Pay, Apple Pay |
| **Protocol gateways** | x402 remote resource payment, AP2 remote mandate submission, MPP remote invoice payment — paying any service that supports these protocols |
| **Key management** | Pluggable KMS providers: AWS KMS, OS Keyring (KDE Wallet / GNOME Keyring / macOS Keychain / Windows Credential Manager), D-Bus Secret Service, GnuPG, Local AES-256-GCM |
| **Policy engine** | Per-tx limits, daily/weekly/monthly aggregates, time-of-day, blacklist/whitelist, currency restrictions |
| **Human-in-the-loop** | Automatic escalation on policy violations via CLI prompt, chat prompt, or web API |
| **Audit trail** | Every action logged to SQLite `audit_log` table + Winston (stdout/stderr/file) |
| **Three interfaces** | OpenClaw (or other agent) chat, CLI (`agentic-payments-bot`), REST web API |
| **Fully configurable** | Single YAML file controls all behavior |

---

## Architecture

### System Diagram

```
┌───────────────────────────────────────────────────────────────────────────────────┐
│                           Agent Payments Skill                                    │
│                                                                                   │
│  ┌─────────────────── SERVER SIDE (Accept Payments) ───────────────────────────┐  │
│  │                                                                             │  │
│  │  External Agents ──► x402 Paywall Middleware (HTTP 402 flow)                │  │
│  │                      AP2 Mandate Endpoints (mandate lifecycle)              │  │
│  │                      MPP Endpoints (quote → invoice → settle →   ──► Payment│  │
│  │                      receipt)                                     Execution │  │
│  └─────────────────────────────────────────────────────────────────────────────┘  │
│                                                                                   │
│  ┌───────────┐   ┌───────────────┐   ┌──────────┐                                 │
│  │  Chat UI  │   │   CLI (term)  │   │ Web API  │                                 │
│  └─────┬─────┘   └───────┬───────┘   └────┬─────┘                                 │
│        │                 │                │                                       │
│        ▼                 ▼                ▼                                       │
│  ┌────────────────────────────────────────────────────┐                           │
│  │              Protocol Router                       │                           │
│  │  (AI output parser → PaymentIntent → routing)      │                           │
│  └────┬──────────┬─────────┬──────────┬──────────┬────┘                           │
│       │          │         │          │          │                                │
│  ┌────▼───┐ ┌────▼───┐ ┌───▼────┐ ┌───▼────┐ ┌───▼────┐                           │
│  │ web3   │ │ web2   │ │ x402   │ │ ap2    │ │ mpp    │                           │
│  │(Viem)  │ │(Stripe │ │(remote │ │(remote │ │(remote │                           │
│  │        │ │PayPal  │ │resource│ │mandate │ │invoice │                           │
│  │        │ │Visa MC │ │client) │ │client) │ │client) │                           │
│  │        │ │GPay    │ │        │ │        │ │        │                           │
│  │        │ │APay)   │ │        │ │        │ │        │                           │
│  └────┬───┘ └───┬────┘ └───┬────┘ └───┬────┘ └───┬────┘                           │
│       │         │          │          │          │                                │
│  ┌────▼─────────▼──────────▼──────────▼──────────▼────┐                           │
│  │            Policy Engine                           │                           │
│  │  (compliance checks before execution)              │                           │
│  │  ┌───────────────────────────────────────┐         │                           │
│  │  │ • Single tx limit    • Blacklist      │         │                           │
│  │  │ • Daily/Weekly/Mo    • Whitelist      │         │                           │
│  │  │ • Time-of-day        • Currency       │         │                           │
│  │  └───────────────────────────────────────┘         │                           │
│  │       │ (violation?) ──► Human Confirm             │                           │
│  └───────┼────────────────────────────────────────────┘                           │
│          │                                                                        │
│  ┌───────▼─────────────────────────────────────┐  ┌───────────────┐               │
│  │          Payment Execution                  │  │  KMS Provider │               │
│  │  ┌────────┐ ┌────────┐ ┌────────┐ ┌──────┐  │  │ ┌───────────┐ │               │
│  │  │ Viem   │ │ Stripe │ │ Visa   │ │ x402 │  │  │ │ AWS KMS   │ │               │
│  │  │(ETH/   │ │ PayPal │ │ MC     │ │ AP2  │  │  │ │ OS Keyring│ │               │
│  │  │ ERC20/ │ │ GPay   │ │        │ │ MPP  │  │  │ │ D-Bus SS  │ │               │
│  │  │ EIP-   │ │ APay   │ │        │ │      │  │◄─│ │ GnuPG     │ │               │
│  │  │ 3009)  │ │        │ │        │ │      │  │  │ │ Local AES │ │               │
│  │  └────────┘ └────────┘ └────────┘ └──────┘  │  │ └───────────┘ │               │
│  └──────────────┬──────────────────────────────┘  └───────────────┘               │
│                 │                                                                 │
│  ┌──────────────▼──────────────────────────────┐                                  │
│  │                  SQLite                     │                                  │
│  │  ┌──────────────┐ ┌──────────┐ ┌──────────┐ │                                  │
│  │  │encrypted_keys│ │transac-  │ │audit_log │ │                                  │
│  │  │              │ │tions     │ │          │ │                                  │
│  │  └──────────────┘ └──────────┘ └──────────┘ │                                  │
│  └─────────────────────────────────────────────┘                                  │
└───────────────────────────────────────────────────────────────────────────────────┘
```

### Directory Structure

```
agentic-payments-bot/
├── SKILL.md                          # Open Agent Skills Ecosystem compliant skill definition (YAML frontmatter + markdown)
├── package.json                      # npm package manifest
├── tsconfig.json                     # TypeScript compiler config
├── .env.example                      # Environment variable template
├── .gitignore
├── config/
│   └── default.yaml                  # Master YAML configuration
├── src/
│   ├── index.ts                      # Main entry point / orchestrator
│   ├── cli.ts                        # CLI interface (Commander.js)
│   ├── web-api.ts                    # REST API (Express) — includes x402/AP2 server endpoints
│   ├── config/
│   │   └── loader.ts                 # YAML config loader + Zod validation
│   ├── protocols/
│   │   ├── router.ts                 # Protocol router + AI output parser
│   │   ├── x402/
│   │   │   ├── client.ts             # x402 HTTP 402 client (paying for resources)
│   │   │   ├── eip3009.ts            # EIP-3009 TransferWithAuthorization signer (EIP-712 via Viem)
│   │   │   └── server.ts             # x402 paywall middleware & settlement (accepting payments)
│   │   ├── ap2/
│   │   │   ├── client.ts             # AP2 mandate-based client (submitting mandates)
│   │   │   └── server.ts             # AP2 mandate lifecycle server (processing mandates)
│   │   └── mpp/
│   │       ├── types.ts              # MPP shared types (Quote, Invoice, SettleRequest, Receipt)
│   │       ├── client.ts             # MPP client (quote → invoice → settle → receipt)
│   │       └── server.ts             # MPP server (content-addressed invoices, signed receipts, rail dispatch)
│   ├── payments/
│   │   ├── web3/
│   │   │   └── ethereum.ts           # Viem-based ETH/ERC-20 tx producer
│   │   └── web2/
│   │       └── gateways.ts           # Stripe, PayPal, Visa, MasterCard, Google Pay, Apple Pay
│   ├── kms/
│   │   ├── provider.ts               # KmsProvider interface (shared contract)
│   │   ├── factory.ts                # Provider factory (selects backend from config)
│   │   ├── aws-kms.ts                # Public API: encryptAndStore / retrieveAndDecrypt
│   │   ├── aws-kms-provider.ts       # AWS KMS provider implementation
│   │   ├── os-keyring-provider.ts    # OS Keyring via @aspect-build/keytar
│   │   ├── dbus-secret-service-provider.ts  # Linux D-Bus Secret Service (dbus-next)
│   │   ├── gpg-provider.ts           # GnuPG encryption for headless Linux
│   │   └── local-aes-provider.ts     # Local AES-256-GCM (fallback / dry-run)
│   ├── dry-run/
│   │   ├── crypto.ts                 # Local AES-256-GCM encryption (no KMS)
│   │   ├── stubs.ts                  # Gateway stub responses (success/failure/random)
│   │   └── wallet.ts                 # Viem key generation + local encrypt/store
│   ├── db/
│   │   ├── sqlite.ts                 # SQLite init + migrations
│   │   ├── key-store.ts              # Encrypted key CRUD
│   │   ├── transactions.ts           # Transaction records + aggregates
│   │   └── audit.ts                  # Audit trail read/write
│   ├── policy/
│   │   ├── engine.ts                 # Policy rule evaluator
│   │   └── feedback.ts               # Human confirmation (CLI/chat/API)
│   └── logging/
│       └── logger.ts                 # Winston multi-transport logger
├── data/                             # (created at runtime)
│   └── payments.db                   # SQLite database
└── logs/                             # (created at runtime)
    └── payment-skill.log             # File log output
```

### Data Flow

#### Client Side — Making Payments (Agent → External Services)

```
User/Agent input
       │
       ▼
┌──────────────────┐     ┌──────────────────────┐
│ Parse AI Output  │────►│ Validate JSON Schema │
│ (regex + JSON)   │     │ (Zod PaymentIntent)  │
└──────────────────┘     └──────────┬───────────┘
                                    │
                                    ▼
                         ┌──────────────────────┐
                         │   Protocol Router    │
                         │ (detect gateway:     │
                         │  web3/web2/x402/     │
                         │  ap2/mpp)            │
                         └──────────┬───────────┘
                                    │
                                    ▼
                         ┌──────────────────────┐
                         │ Create Transaction   │
                         │ Record (SQLite)      │
                         └──────────┬───────────┘
                                    │
                                    ▼
                         ┌───────────────────────┐
                         │   Policy Engine       │◄── rules from YAML
                         │ • limits check        │◄── aggregates from SQLite
                         │ • blacklist/whitelist │
                         │ • time restrictions   │
                         └──────────┬────────────┘
                                    │
                            ┌───────┴────────┐
                            │  violations?   │
                            └───┬────────┬───┘
                           yes  │        │ no
                                ▼        │
                    ┌───────────────┐    │
                    │ Human Confirm │    │
                    │ (CLI/Chat/API)│    │
                    └───────┬───────┘    │
                     reject │ confirm    │
                       ▼    │    ┌───────┘
                    REJECT  │    │
                            ▼    ▼
                    ┌──────────────────────┐
                    │  Decrypt Keys (KMS)  │
                    └─────────┬────────────┘
                              │
              ┌───────────────┼────────────────┐
              │               │                │
     ┌────────▼──────┐ ┌──────▼──────┐ ┌───────▼───────┐
     │ web3 (Viem)   │ │ web2        │ │ Protocol      │
     │ ETH / ERC-20  │ │ Stripe      │ │ Clients       │
     │               │ │ PayPal      │ │               │
     │ Direct chain  │ │ Visa / MC   │ │ x402: discover│
     │ transactions  │ │ GPay / APay │ │ → sign EIP-   │
     │               │ │             │ │ 3009 (KMS key)│
     │               │ │             │ │ → pay         │
     │               │ │             │ │ → get resource│
     │               │ │             │ │               │
     │               │ │             │ │ AP2: mandate  │
     │               │ │             │ │ → sign → cred │
     │               │ │             │ │ → submit      │
     │               │ │             │ │               │
     │               │ │             │ │ MPP: quote    │
     │               │ │             │ │ → invoice     │
     │               │ │             │ │ → settle(rail)│
     │               │ │             │ │ → receipt     │
     └────────┬──────┘ └──────┬──────┘ └───────┬───────┘
              │               │                │
              └───────────────┼────────────────┘
                              │
                    ┌─────────▼───────────┐
                    │  Update Transaction │
                    │  + Audit Log        │
                    └─────────────────────┘
```

#### Server Side — Accepting Payments (External Agents → This Service)

```
                    ┌──────────────────────────────────────┐
                    │       External Agent Request         │
                    └──────┬──────────┬──────────┬─────────┘
                           │          │          │
              x402 path    │          │ AP2 path │  MPP path
         ┌─────────────────┘          │          └───────────────────┐
         │                            │                              │
         ▼                            ▼                              ▼
┌────────────────────────┐ ┌──────────────────────────┐ ┌──────────────────────────┐
│ GET /x402/premium/data │ │ POST /ap2/mandates       │ │ POST /mpp/quote          │
│ (any paywall route)    │ │ (accept mandate)         │ │ (issue quote)            │
└───────────┬────────────┘ └────────────┬─────────────┘ └────────────┬─────────────┘
            │                           │                            │
     ┌──────┴──────┐                    ▼                            ▼
     │ X-PAYMENT   │      ┌──────────────────────────┐ ┌──────────────────────────┐
     │ header?     │      │ POST /ap2/sign-mandate   │ │ POST /mpp/invoice        │
     └──┬──────┬───┘      │ (credential provider)    │ │ (content-addressed,      │
     no │      │ yes      └────────────┬─────────────┘ │  signed invoice)         │
        ▼      │                       │               └────────────┬─────────────┘
 ┌────────────┐│                       ▼                            │
 │ HTTP 402   ││      ┌──────────────────────────────┐              ▼
 │ + payment  ││      │ POST /ap2/payment-credentials│ ┌──────────────────────────┐
 │ requirem.  ││      │ (issue scoped tokens)        │ │ POST /mpp/settle         │
 │ in X-PAY-  ││      └────────────┬─────────────────┘ │ (rail: x402 / stripe /   │
 │ MENT hdr   ││                   │                   │  paypal / card / crypto) │
 └────────────┘│                   ▼                   └────────────┬─────────────┘
               ▼            ┌────────────────────────────┐          │
    ┌─────────────────────┐ │ POST /ap2/process-payment  │          ▼
    │ Validate payload:   │ └────────────┬───────────────┘ ┌────────────────────────┐
    │ • auth fields       │              │                 │ GET /mpp/receipt/:id   │
    │ • EIP-3009 signed   │              │                 │ (signed receipt)       │
    │   authorization     │              │                 └────────────┬───────────┘
    │ • amount ≥ required │              │                              │
    │ • time bounds       │              │                              │
    │ • payTo matches     │              │                              │
    └──────────┬──────────┘              │                              │
               │                         │                              │
               ▼                         ▼                              ▼
    ┌─────────────────────┐ ┌──────────────────────────────┐ ┌──────────────────────────┐
    │ Submit to on-chain  │ │ Route to internal backend:   │ │ Settle on chosen rail:   │
    │ facilitator for     │ │ • stripe  • paypal  • card   │ │ • x402 → facilitator     │
    │ settlement          │ │ • crypto (Viem ETH/ERC-20)   │ │ • stripe/paypal/card     │
    └──────────┬──────────┘ └──────────────┬───────────────┘ │ • crypto (tx reference)  │
               │                           │                 └──────────────┬───────────┘
               ▼                           ▼                                │
    ┌─────────────────────┐ ┌──────────────────────────────┐               │
    │ HTTP 200            │ │ Return AP2PaymentResult:     │               ▼
    │ + resource data     │ │ { mandate_id, status,        │ ┌──────────────────────────┐
    │ + X-PAYMENT-RESPONSE│ │   transaction_id, receipt }  │ │ Return MPPReceipt:       │
    │   (settlement proof)│ └──────────────┬───────────────┘ │ { receipt_id, status,    │
    └──────────┬──────────┘                │                 │   rail_reference, sig }  │
               │                           │                 └──────────────┬───────────┘
               └──────────────┬────────────┴────────────────────────────────┘
                              │
                   ┌──────────▼──────────┐
                   │  Audit Log (SQLite  │
                   │  + Winston)         │
                   └─────────────────────┘
```

---

## Quick Start

**A quick start guide with Docker and Docker Compose.**

### Usage

**Quick start (dry-run, no credentials needed):**

```bash
# Build and start both services
DRY_RUN=true docker compose up --build -d

# Start everything (first run auto-configures OpenClaw + installs skill)
docker compose up -d

# Or explicitly run skill installation first
docker compose --profile setup run --rm install-skill
docker compose up -d

# Check the payment API health
curl http://localhost:3402/api/v1/health

# Run the demo via the CLI helper
DRY_RUN=true docker compose run --rm cli demo

# Run CLI commands
docker compose run --rm --profile cli cli demo --stub-mode success

# Quick dry-run test
DRY_RUN=true docker compose up -d

# Check logs
docker compose logs -f agentic-payments-bot

# View audit log
DRY_RUN=true docker compose run --rm cli audit --limit 30

# Store a key via CLI
DRY_RUN=true docker compose run --rm cli keys list
```

**Production (with real credentials):**

```bash
# Create a .env file with your secrets
cat > .env <<EOF
AWS_ACCESS_KEY_ID=AKIA...
AWS_SECRET_ACCESS_KEY=...
AWS_KMS_KEY_ID=arn:aws:kms:us-east-1:123456789012:key/...
LLM_PROVIDER=anthropic
LLM_API_KEY=sk-ant-...
OPENCLAW_GATEWAY_TOKEN=your-gateway-token
EOF

# Start
docker compose up --build -d

# Tail logs
docker compose logs -f agentic-payments-bot

# Stop
docker compose down
```

**Pair OpenClaw with a messaging channel (e.g. Telegram):**

```bash
# Run the OpenClaw CLI inside the running container
docker compose exec agentic-payments-bot openclaw pairing approve telegram
```

---

### What this gives you

| Container | Service | Port | Description |
|---|---|---|---|
| `agentic-payments-bot` | Payment Bot Web API (`npm run web`) | `3402` | REST API for payments, parsing, confirmations, audit |
| `agentic-payments-bot` | OpenClaw Gateway (`openclaw gateway`) | `18789` | Agent gateway (Telegram, Slack, WhatsApp, etc.) |
| `agentic-payments-bot` | OpenClaw Bridge (`openclaw`) | `18790` | Internal bridge for multi-channel routing |
| `agentic-payments-bot` | CLI (on-demand) (`npm run cli`) | — | Runs `agentic-payments-bot` CLI commands against the shared SQLite DB |

Both services share the same SQLite database and encrypted key store through Docker volumes [[1]](https://til.simonwillison.net/llms/openclaw-docker). The payment skill is auto-registered as an OpenClaw skill via the symlink into `~/.openclaw/skills/` [[2]](https://docs.openclaw.ai/tools/skills), so the agent discovers it at startup through the standard skill loading mechanism.

---

## Documentation

See the [`REFERENCE_README`](docs/REFERENCE_README.md) file for the full exhaustive comprehensive thorough documentation and details.

---

## License

This project is licensed under the **Apache 2.0 License**. See the [`LICENSE-APACHE`](LICENSE-APACHE) file for the details.

---

> Built with 🤖💵 for the [Open Agent Skills Ecosystem](https://www.npmjs.com/package/skills#supported-agents) and for the [OpenClaw](https://openclaw.ai) ecosystem.
> 
> Protocols: [x402](https://x402.org/) · [AP2](https://ap2-protocol.org/) · [MPP](https://mpp.dev)
