# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Node + React (user's choice, 2026-10-20). The console is a new app inside the no-phone repo; the rest of no-phone stays Python (FastAPI/FastMCP) and Go (WhatsApp bridge).

## Users

- **Owner of a secretary (tenant).** Today only Goyo; the intent is that several people each run their own secretary, so the console is multi-tenant: each tenant sees and controls only their own secretary, memory, tools and tasks.
- Situation: at a computer (later a VPS reached over Tailscale), checking what the secretary knows, fixing what it got wrong, adjusting how it behaves and seeing whether its tools are alive.

## Product Purpose

no-phone is a personal AI secretary that knows its owner and resolves short, vague requests ("¿mi familia me escribió?", "mandale 500 a Seba", "a las 17 avisame qué micros tomar") using tools: WhatsApp, Naranja X (via a physical Android over adb), and Mendoza transit/maps. The admin console is where the owner controls it. Success: the owner can trust the secretary because they can see and correct what it remembers and how it is configured.

## Positioning

The secretary acts on the owner's real accounts and phone (not official APIs), and its memory is a knowledge graph of the owner's own world (people, groups, places, and how each one appears inside each tool). The console exposes that memory and those levers directly instead of hiding them.

## Operating Context

- Agent runtime: Hermes Agent (per-tenant profile: config, `SOUL.md` personality, MCP servers, cron jobs at `cron/jobs.json`).
- Memory: Hindsight (MIT) over HTTP at `127.0.0.1:8888`, one memory bank per tenant (`goyo` today), with entities, facts (world / experience), consolidated observations, mental models, entity graph and per-bank config (retain mission, observations mission, entity labels, `recall_max_tokens`). Hindsight also ships its own control plane UI at `:9999`.
- Tools (MCP servers): `whatsapp` (10 tools), `naranjax` (16 tools, Naranja X on the Android), `movilidad` (6 tools).
- Device: Redmi 7 over adb (USB locally, or a remote adb server over Tailscale when on a VPS).
- Scheduled tasks and monitors: Hermes cron jobs the secretary creates on request ("a las 17 avisame…", "avisame si mi vieja me escribe"), with expiry for monitors.
- Language of the product: Spanish (rioplatense).

## Capabilities and Constraints

v1 must cover all four:
1. **Memory:** browse and edit what the secretary remembers (entities, facts, observations, graph); correct or delete wrong memories.
2. **Secretary config:** personality (`SOUL.md`), bank missions, model, recall token budget, limits.
3. **Tool status:** MCP servers connected or not, phone over adb, services (Hindsight, WhatsApp bridge) up or down.
4. **Tasks and monitors:** see, pause and cancel scheduled jobs.

Constraints:
- Holds personal data and can lead to money moving: bind to loopback / tailnet only, require auth, never display secrets (PIN, API keys, tokens).
- Tenancy model is open: today one tenant (`goyo`) maps to one Hermes profile and one Hindsight bank; sign-in and tenant provisioning are undecided.
- The model provider for the agent is undecided (currently DeepSeek, key invalid as of 2026-10-20).

## Brand Commitments

- Name: **no-phone**.
- Voice: short, direct rioplatense Spanish, like a trusted secretary.
- Visual direction pinned by the user: Impeccable world `operate-c-cracktro-scroller-queue` (Cracktro Scroller Queue).

## Evidence on Hand

Real data available locally: the `goyo` memory bank (empty until the LLM key works), Hermes config and `SOUL.md`, three MCP servers, the WhatsApp bridge status endpoint. No other tenants, customers or testimonials exist; do not fabricate them.

## Product Principles

1. The owner can always see why the secretary did something: memory and config are inspectable, not magic.
2. Correcting the secretary is cheaper than re-explaining: edit the memory directly.
3. Reading is free, acting is confirmed: nothing in the console sends messages or moves money.
4. Secrets never surface.
5. Each tenant is isolated.
