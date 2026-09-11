# xray-monitor

High-performance, distributed real-time traffic telemetry, multi-hop route resolution, and topology analytics engine for Remnawave and Xray networks.

## Overview

`xray-monitor` is an event-driven telemetry and monitoring engine designed for complex proxy architectures managed by Remnawave. It aggregates real-time connection events from distributed `xray-monitor-node` telemetry agents, correlates them with Remnawave node topology and user metadata, and provides real-time visibility into user activity, gateway utilization, and end-to-end traffic pathways without imposing any performance overhead on the core routing engine.

## Architecture

```text
       ┌────────────────────────┐
       │   Users (Mobile/PC)    │
       └───────────┬────────────┘
                   │
         ┌─────────┴─────────┐
         ▼                   ▼
┌─────────────────┐ ┌─────────────────┐
│ Tunnel Node(s)  │ │ Direct Node(s)  │
│ (Iran / Ingress)│ │ (Bridge / Direct│
│ [xray-monitor-  │ │ [xray-monitor-  │
│      node]      │ │      node]      │
└────────┬────────┘ └────────┬────────┘
         │                   │
         │  POST /api/ingest │
         │  (X-Ingest-Key)   │
         ▼                   ▼
┌─────────────────────────────────────┐      REST API      ┌───────────────────┐
│       xray-monitor Engine           │ ◄────────────────► │  Remnawave Panel  │
│  - SQLite WAL Aggregator            │ (Topology, Users,  │  (Single Source   │
│  - Multi-Hop Pathway Resolver       │  Bandwidth Stats)  │   of Truth)       │
│  - Subtractive Gateway Calculator   │                    └───────────────────┘
│  - Dark Cyberpunk Web Dashboard     │
└─────────────────────────────────────┘
```

## Features

- **Distributed Telemetry Ingestion:** Collects lightweight, buffered telemetry streams from remote edge nodes running `xray-monitor-node`.
- **Multi-Hop Dynamic Route Resolution:** Dynamically maps connection journeys end-to-end:
  - *Direct Ingress:* Resolves directly to the edge gateway and egress (`DE1: in-default → warp`).
  - *Tunneled Ingress:* Traces hops through transit relays to the exit bridge (`IR1: in-default-loop → DE1: in-default → warp`).
- **Mathematical Subtractive Traffic Calculation:** Implements accurate traffic separation for bridge inbounds that serve both direct and tunneled connections:
  $$\text{Direct Traffic} = \text{Bridge Inbound Traffic} - \sum(\text{Tunneled Traffic of Feeding Hops})$$
- **Automatic SQLite Schema Migrations:** Auto-detects and migrates SQLite table structures (e.g. `connected_node`) on startup with WAL mode for zero-lock concurrency.
- **Deep Packet Inspection (DPI) Categorization:** Classifies destinations into high-level categories (Google/YouTube, Meta/Instagram, Cloudflare, Telegram, CDN, General).
- **Interactive Dashboard:**
  - Sortable user activity tables by User ID, Status, Requests in Range, Unique Domains, and Last Active.
  - Multi-timeframe metrics (`1h`, `6h`, `24h`, `7d`, `All`).
  - Live connection stream with Tehran local time display (`Asia/Tehran`).
  - Per-user destination drilldowns and historical timeline charts.

## Quick Start (Docker Compose)

1. Create a `docker-compose.yml` file:

```yaml
services:
  xray-monitor:
    image: ghcr.io/oximeter-cloud/xray-monitor:latest
    container_name: xray-monitor
    restart: unless-stopped
    ports:
      - "127.0.0.1:9922:9922"
    environment:
      - PORT=9922
      - DATA_DIR=/app/data
      - REMNAWAVE_API_URL=https://panel.example.com/api
      - REMNAWAVE_API_TOKEN=your_remnawave_bearer_token
      - INGEST_SECRET=your_secure_ingest_secret
    volumes:
      - ./data:/app/data
```

2. Start the service:

```bash
docker compose up -d
```

3. Configure reverse proxy with Basic Auth (Caddy example):

To protect the web interface with Basic Auth while allowing remote agents to push telemetry without credential prompts, bypass `/api/ingest*`:

```caddy
monitor.example.com {
    tls internal

    # Protect the dashboard, but allow agent ingestion
    @auth {
        not path /api/ingest*
    }
    basicauth @auth {
        admin $2a$14$...password_hash...
    }

    reverse_proxy 127.0.0.1:9922 {
        header_up Host {host}
        header_up X-Real-IP {remote_host}
        header_up X-Forwarded-For {remote_host}
    }
}
```

*Note: Ingestion endpoints remain authenticated at the application layer via the required `X-Ingest-Key` header.*

## Environment Variables

| Variable | Description | Default |
| :--- | :--- | :--- |
| `PORT` | Listening HTTP port | `9922` |
| `DATA_DIR` | Directory where SQLite database is stored | `/app/data` |
| `REMNAWAVE_API_URL` | Remnawave REST API base URL | `https://panel.example.com/api` |
| `REMNAWAVE_API_TOKEN` | Bearer token for Remnawave API | `(required)` |
| `INGEST_SECRET` | Secret key required in `X-Ingest-Key` for telemetry batches | `(required)` |
| `EXCLUDED_USER_IDS` | Comma-separated user IDs to exclude from reporting | `""` |

## REST API Reference

| Endpoint | Method | Description |
| :--- | :--- | :--- |
| `/api/ingest` | POST | Receive telemetry batches from edge nodes (`X-Ingest-Key` required) |
| `/api/summary` | GET | Key performance indicators (requests, users, domains, traffic) |
| `/api/top-inbounds` | GET | Inbound gateway usage with Direct vs. Tunneled breakdown |
| `/api/live-stream` | GET | Latest raw connection events with resolved multi-hop pathways |
| `/api/users` | GET | User leaderboard with status, request counts, and node assignment |
| `/api/user/:id` | GET | Historical destination log and top categories for a specific user |
| `/api/timeline` | GET | Time-series request distribution over selected timeframe |
| `/api/top-domains` | GET | Top visited domain destinations and categories |
| `/api/remna/sessions`| GET | Live health, heartbeat status, and metrics for all active nodes |

## Resource Benchmarks

Tested on a production instance with 140+ active users and millions of monthly records:
- **RAM Usage:** ~85MB
- **CPU Usage:** < 1.0% (2 vCPU host)
- **Database:** SQLite in WAL mode with memory temporary store

## Distributed Agent

Deploy [xray-monitor-node](https://github.com/oximeter-cloud/xray-monitor-node) on each edge node to stream connection logs to this central monitor.

## License

MIT License.
