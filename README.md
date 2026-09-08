# xray-monitor

High-performance, distributed real-time traffic telemetry and topology analytics dashboard for Remnawave and Xray networks.

## Overview
`xray-monitor` is an event-driven monitoring and analytics engine designed specifically for multi-node proxy architectures managed by Remnawave. It aggregates live connection telemetry from distributed `xray-monitor-node` telemetry agents, correlates them with Remnawave topology and user metadata, and renders high-fidelity traffic analytics with zero performance impact on core routing.

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
│  (IR1-Oximeter) │ │  (DE1-Oximeter) │
│  [xray-monitor- │ │  [xray-monitor- │
│      node]      │ │      node]      │
└────────┬────────┘ └────────┬────────┘
         │                   │
         │  POST /api/ingest │
         ▼                   ▼
┌─────────────────────────────────────┐      REST API      ┌───────────────────┐
│       xray-monitor Engine           │ ◄────────────────► │  Remnawave Panel  │
│  - SQLite WAL Aggregator            │ (Topology, Users,  │  (Single Source   │
│  - Real-time DPI & Route Mapper     │  Bandwidth Stats)  │   of Truth)       │
│  - Dark Cyberpunk Web Dashboard     │                    └───────────────────┘
└─────────────────────────────────────┘
```

## Features
- **Distributed Telemetry Ingestion:** Accepts lightweight, batch-buffered JSON telemetry streams from distributed `xray-monitor-node` instances.
- **Dynamic Topology & Ingress Mapping:** Tracks connections end-to-end across Bridge, Tunnel, and Outbound hops. Accurately separates Direct ingress from Tunneled ingress with intelligent loop deduplication.
- **Live Node Telemetry Status:** Displays the real-time heartbeat and connection ingestion rates for all distributed agents in the network.
- **Deep Packet Inspection (DPI) Categorization:** Classifies domains and destination IPs into high-level categories (Google/YouTube, Meta/Instagram, Cloudflare, Telegram, CDN, etc.).
- **Zero-Friction Storage:** Powered by Node 22 native SQLite with Write-Ahead Logging (WAL) and memory caching. Consumes < 70MB RAM under peak load.
- **REST API & Modern Frontend:** Built with Hono and Tailwind CSS for instant live streaming, historical charts, user leaderboards, and inbound utilization.

## Quick Start (Docker Compose)

1. Create a `docker-compose.yml` file:
```yaml
services:
  xray-monitor:
    image: ghcr.io/oximeter-cloud/xray-monitor:latest
    container_name: xray-monitor
    restart: always
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

3. Access the dashboard:
Open `http://127.0.0.1:9922` in your browser or put it behind a reverse proxy (Caddy, Nginx).

## Environment Variables

| Variable | Description | Default |
| :--- | :--- | :--- |
| `PORT` | Listening HTTP port | `9922` |
| `DATA_DIR` | Directory where SQLite database is stored | `/app/data` |
| `REMNAWAVE_API_URL` | Remnawave REST API base endpoint | `https://panel.example.com/api` |
| `REMNAWAVE_API_TOKEN` | Bearer token for Remnawave API | `(required)` |
| `INGEST_SECRET` | Secret key required in `X-Ingest-Key` for telemetry batches | `(required)` |
| `EXCLUDED_USER_IDS` | Comma-separated user IDs to exclude from reporting | `""` |

## Distributed Nodes
To stream telemetry from edge Xray nodes, deploy [xray-monitor-node](https://github.com/oximeter-cloud/xray-monitor-node) alongside your Xray/Remnanode containers.

## License
MIT License.
