import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

try {
  if (existsSync(".env")) {
    process.loadEnvFile(".env");
  } else if (existsSync("/root/apps/xray-monitor/.env")) {
    process.loadEnvFile("/root/apps/xray-monitor/.env");
  }
} catch {}

import { XrayCollector } from "./collector";
import {
  querySummary,
  queryTopDomains,
  queryTopInbounds,
  queryTimeline,
  queryUsers,
  queryUserDetail,
  queryDomainDetail,
  queryLiveStream,
  formatBytes,
} from "./database";
import {
  getRemnawaveNodes,
  getRemnawaveConfigProfiles,
  resolveConnectionNodes,
  getFeedingTunnelInbounds,
  isBridgeRole,
  type RemnaNode,
} from "./topology";
import { parseFormattedBytes } from "./utils";

const app = new Hono();
app.use("*", cors());

const collector = new XrayCollector();
collector.start();

const staticPath = existsSync(join(process.cwd(), "static/index.html"))
  ? join(process.cwd(), "static/index.html")
  : (existsSync(join(import.meta.dirname || ".", "../static/index.html"))
    ? join(import.meta.dirname || ".", "../static/index.html")
    : "/root/apps/xray-monitor/static/index.html");
const HTML_INDEX = readFileSync(staticPath, "utf8");

// Dashboard UI
app.get("/", (c) => {
  return c.html(HTML_INDEX);
});

// Cache for Remnawave egress bandwidth calculation
const egressCache = new Map<string, { bytes: number; formatted: string; exp: number }>();

// Remnawave API Client helpers
const REMNA_URL = process.env.REMNAWAVE_API_URL || "https://panel.example.com/api";
const REMNA_TOKEN = process.env.REMNAWAVE_API_TOKEN || "";

async function remnaFetch(endpoint: string): Promise<any> {
  const r = await fetch(`${REMNA_URL}${endpoint}`, {
    headers: { Authorization: `Bearer ${REMNA_TOKEN}`, Accept: "application/json" },
  });
  if (!r.ok) throw new Error(`Remnawave API returned ${r.status}`);
  return r.json() as Promise<any>;
}

// API Routes
app.get("/api/summary", async (c) => {
  const hours = parseInt(c.req.query("hours") || "24", 10);
  const userIdStr = c.req.query("user_id");
  const userId = userIdStr ? parseInt(userIdStr, 10) : undefined;
  const inbound = c.req.query("inbound") || undefined;
  const node = c.req.query("node") || undefined;

  const summary = querySummary(hours, userId, inbound, node);

  // Fetch or get cached Remnawave egress traffic for the timeframe
  try {
    const isSubDay = hours < 24;
    const now = new Date();
    const end = now.toISOString().slice(0, 10);
    const daysBack = isSubDay || hours === 24 ? 0 : Math.min(365, Math.ceil(hours / 24) - 1);
    const start = new Date(now.getTime() - daysBack * 86400000).toISOString().slice(0, 10);
    const cacheKey = `${start}_${end}`;

    const nodes = await getRemnawaveNodes();
    const tunnelNames = new Set(nodes.filter((n) => n.role === "TUNNEL").map((n) => n.name.toLowerCase()));
    const egressNodeNames = nodes.filter((n) => n.role !== "TUNNEL").map((n) => n.shortName);
    (summary as any).egress_nodes = egressNodeNames;

    // Timeframe label: if sub-day (e.g. 1h, 6h, 12h), Remnawave daily API cannot scope by hours,
    // so we set egress_timeframe_label to null so the UI omits the timeframe tag completely.
    (summary as any).egress_timeframe_label = isSubDay
      ? null
      : (hours === 24 ? "24h" : `${Math.round(hours / 24)}d`);

    const cached = egressCache.get(cacheKey);
    if (cached && cached.exp > Date.now()) {
      (summary as any).remnawave_egress_bytes = cached.bytes;
      (summary as any).remnawave_egress_formatted = cached.formatted;
    } else {
      const bwRes = await remnaFetch(`/bandwidth-stats/nodes?start=${start}&end=${end}`).catch(() => ({ response: {} }));
      const series = bwRes.response?.series || [];
      let egressBytes = 0;
      for (const s of series) {
        if (tunnelNames.has(s.name.toLowerCase())) continue; // Dynamically skip any TUNNEL nodes
        for (const val of (s.data || [])) {
          egressBytes += (val || 0);
        }
      }
      const formatted = formatBytes(egressBytes);
      egressCache.set(cacheKey, { bytes: egressBytes, formatted, exp: Date.now() + 60000 });
      (summary as any).remnawave_egress_bytes = egressBytes;
      (summary as any).remnawave_egress_formatted = formatted;
    }
  } catch {
    (summary as any).remnawave_egress_formatted = summary.total_traffic_formatted;
  }

  return c.json(summary);
});

app.get("/api/top-domains", (c) => {
  const hours = parseInt(c.req.query("hours") || "24", 10);
  const limit = parseInt(c.req.query("limit") || "20", 10);
  const userIdStr = c.req.query("user_id");
  const userId = userIdStr ? parseInt(userIdStr, 10) : undefined;
  const inbound = c.req.query("inbound") || undefined;
  const search = c.req.query("search") || undefined;
  const node = c.req.query("node") || undefined;

  return c.json(queryTopDomains(hours, limit, userId, inbound, search, node));
});

// Clean, dynamic Inbound Gateways Engine across all Tunnels and Bridges
app.get("/api/top-inbounds", async (c) => {
  const hours = parseInt(c.req.query("hours") || "24", 10);
  const userIdStr = c.req.query("user_id");
  const userId = userIdStr ? parseInt(userIdStr, 10) : undefined;
  const node = c.req.query("node") || undefined;

  // 1. Query recorded inbounds from database for the timeframe
  const rawInbounds = queryTopInbounds(hours, userId, node);

  const [nodes, profiles, metricsData] = await Promise.all([
    getRemnawaveNodes(),
    getRemnawaveConfigProfiles(),
    remnaFetch("/system/nodes/metrics").catch(() => ({ response: { nodes: [] } })),
  ]);

  const liveInboundStatsMap = new Map<string, {
    upload_bytes: number;
    download_bytes: number;
    total_bytes: number;
    upload_formatted: string;
    download_formatted: string;
    total_formatted: string;
    node_name: string;
  }>();

  for (const n of metricsData.response?.nodes || []) {
    const nName = n.nodeName || "";
    for (const ib of n.inboundsStats || []) {
      if (!ib.tag || ib.tag === "REMNAWAVE_API_INBOUND") continue;
      const up = parseFormattedBytes(ib.upload);
      const down = parseFormattedBytes(ib.download);
      const tot = up + down;
      liveInboundStatsMap.set(ib.tag, {
        upload_bytes: up,
        download_bytes: down,
        total_bytes: tot,
        upload_formatted: ib.upload || formatBytes(up),
        download_formatted: ib.download || formatBytes(down),
        total_formatted: formatBytes(tot),
        node_name: nName,
      });
    }
  }

  const activeInbounds = rawInbounds.filter(
    (ib) => (ib.total_hits || 0) > 0 || (ib.total_bytes || 0) > 0 || liveInboundStatsMap.has(ib.inbound)
  );

  const tunnelNodes = nodes.filter((n) => n.role === "TUNNEL");
  const bridgeNodes = nodes.filter((n) => n.role === "BRIDGE");

  // Map of total recorded stats per inbound tag
  const inboundStatsMap = new Map<string, { hits: number; bytes: number; users: number }>();
  for (const ib of activeInbounds) {
    const live = liveInboundStatsMap.get(ib.inbound);
    const bytes = (ib.total_bytes && ib.total_bytes > 0) ? ib.total_bytes : (live?.total_bytes || 0);
    inboundStatsMap.set(ib.inbound, {
      hits: ib.total_hits || 0,
      bytes,
      users: ib.users_count || 0,
    });
  }

  const chains: any[] = [];

  for (const ib of activeInbounds) {
    const tag = ib.inbound;
    if (tag.includes("API")) continue;

    const liveStats = liveInboundStatsMap.get(tag);
    const totalBytes = (ib.total_bytes && ib.total_bytes > 0) ? ib.total_bytes : (liveStats?.total_bytes || 0);
    const uplinkFormatted = (ib.uplink_bytes && ib.uplink_bytes > 0) ? ib.uplink_formatted : (liveStats?.upload_formatted || "0 B");
    const downlinkFormatted = (ib.downlink_bytes && ib.downlink_bytes > 0) ? ib.downlink_formatted : (liveStats?.download_formatted || "0 B");
    const totalFormatted = totalBytes > 0 ? formatBytes(totalBytes) : (liveStats?.total_formatted || "0 B");

    // Identify owner node from Remnawave config or metrics
    const ownerNode = nodes.find((n) => n.activeInbounds.some((i) => i.tag === tag)) ||
      nodes.find((n) => n.name === liveStats?.node_name);
    const isBridge = ownerNode ? ownerNode.role === "BRIDGE" : bridgeNodes.some((b) => b.activeInbounds.some((i) => i.tag === tag));
    const isTunnel = ownerNode ? ownerNode.role === "TUNNEL" : tunnelNodes.some((t) => t.activeInbounds.some((i) => i.tag === tag));

    // If user filtered by specific node, filter accordingly
    if (node) {
      const matchNode = ownerNode && (ownerNode.name === node || ownerNode.shortName === node);
      if (!matchNode) continue;
    }

    let directHits = 0;
    let tunneledHits = 0;
    let directBytes = 0;
    let tunneledBytes = 0;
    let directUsers = 0;
    let tunneledUsers = 0;
    let feedingTunnels: string[] = [];

    if (isBridge) {
      // FORMULA: direct traffic = bridge inbound traffic - sum(tunneled traffic of before hops)
      feedingTunnels = getFeedingTunnelInbounds(profiles, tag);
      const tunneledFromFeeders = feedingTunnels.reduce((sum, tTag) => sum + (inboundStatsMap.get(tTag)?.hits || 0), 0);
      const tunneledBytesFromFeeders = feedingTunnels.reduce((sum, tTag) => sum + (inboundStatsMap.get(tTag)?.bytes || 0), 0);
      const tunneledUsersFromFeeders = feedingTunnels.reduce((sum, tTag) => Math.max(sum, inboundStatsMap.get(tTag)?.users || 0), 0);

      tunneledHits = Math.max(ib.tunneled_hits || 0, tunneledFromFeeders);
      tunneledBytes = tunneledBytesFromFeeders;
      tunneledUsers = Math.max(ib.tunneled_users || 0, tunneledUsersFromFeeders);

      directHits = Math.max(0, (ib.total_hits || 0) - tunneledHits);
      directBytes = Math.max(0, totalBytes - tunneledBytes);
      directUsers = Math.max(0, (ib.users_count || 0) - tunneledUsers);
    } else {
      // FORMULA for tunnel inbound: just show its traffic (without any calculation)
      tunneledHits = ib.total_hits || 0;
      directHits = 0;
      tunneledBytes = totalBytes;
      directBytes = 0;
      tunneledUsers = ib.users_count || 0;
      directUsers = 0;
    }

    const hasTunnels = isTunnel || feedingTunnels.length > 0;
    const isDual = isBridge && feedingTunnels.length > 0 && directHits > 0;
    const chainType = isDual ? "DUAL_ENTRY" : (isTunnel ? "TUNNEL_CHAIN" : "DIRECT_BRIDGE");
    const typeLabel = isDual
      ? "Dual Entry (Tunneled & Direct)"
      : (isTunnel ? "Tunnel Ingress" : "Direct Bridge");

    chains.push({
      tag,
      chain_name: tag.startsWith("in-") ? tag.replace(/^in-/, "").toUpperCase() : tag,
      chain_type: chainType,
      type_label: typeLabel,
      is_tunneled: hasTunnels,
      is_dual: isDual,
      node_name: ownerNode?.name || (isTunnel ? "IR1-Oximeter" : "DE1-Oximeter"),
      node_short: ownerNode?.shortName || (isTunnel ? "IR1" : "DE1"),
      node_role: ownerNode?.role || (isTunnel ? "TUNNEL" : "BRIDGE"),
      feeding_tunnels: feedingTunnels,
      total_hits: ib.total_hits,
      direct_hits: directHits,
      tunneled_hits: tunneledHits,
      users_count: ib.users_count,
      direct_users: directUsers,
      tunneled_users: tunneledUsers,
      total_bytes: totalBytes,
      direct_bytes: directBytes,
      tunneled_bytes: tunneledBytes,
      total_formatted: totalFormatted,
      direct_formatted: formatBytes(directBytes),
      tunneled_formatted: formatBytes(tunneledBytes),
      uplink_formatted: uplinkFormatted,
      downlink_formatted: downlinkFormatted,
    });
  }

  // Sort by total_hits descending, then by total_bytes
  chains.sort((a, b) => (b.total_hits || 0) - (a.total_hits || 0) || (b.total_bytes || 0) - (a.total_bytes || 0));

  return c.json({
    chains,
    nodes: nodes.map((n) => ({ name: n.name, shortName: n.shortName, role: n.role })),
  });
});

app.get("/api/inbound-traffic", async (c) => {
  try {
    const metricsData = await remnaFetch("/system/nodes/metrics").catch(() => ({ response: { nodes: [] } }));
    const list: any[] = [];
    for (const n of metricsData.response?.nodes || []) {
      for (const ib of n.inboundsStats || []) {
        if (!ib.tag || ib.tag === "REMNAWAVE_API_INBOUND") continue;
        const up = parseFormattedBytes(ib.upload);
        const down = parseFormattedBytes(ib.download);
        const tot = up + down;
        list.push({
          inbound: ib.tag,
          node: n.nodeName,
          uplink_bytes: up,
          downlink_bytes: down,
          total_bytes: tot,
          uplink_formatted: ib.upload || formatBytes(up),
          downlink_formatted: ib.download || formatBytes(down),
          total_formatted: formatBytes(tot),
        });
      }
    }
    return c.json(list);
  } catch {
    return c.json(collector.queryXrayLiveStats());
  }
});

app.get("/api/timeline", (c) => {
  const hours = parseInt(c.req.query("hours") || "24", 10);
  const userIdStr = c.req.query("user_id");
  const userId = userIdStr ? parseInt(userIdStr, 10) : undefined;
  const inbound = c.req.query("inbound") || undefined;
  const node = c.req.query("node") || undefined;

  return c.json(queryTimeline(hours, userId, inbound, node));
});

app.get("/api/users", (c) => {
  const hours = parseInt(c.req.query("hours") || "24", 10);
  const search = c.req.query("search") || undefined;

  return c.json(queryUsers(hours, search));
});

app.get("/api/user/:userId", async (c) => {
  const userId = parseInt(c.req.param("userId"), 10);
  const hours = parseInt(c.req.query("hours") || "24", 10);

  const summary = queryUserDetail(userId, hours);

  try {
    const [hwidRes, srhRes, nodes, profiles] = await Promise.all([
      remnaFetch("/hwid/devices?size=500").catch(() => ({ response: { devices: [] } })),
      remnaFetch("/subscription-request-history?size=500").catch(() => ({ response: { records: [] } })),
      getRemnawaveNodes(),
      getRemnawaveConfigProfiles(),
    ]);

    const userDevices = (hwidRes.response?.devices || []).filter((d: any) => d.userId === userId);
    const userSrh = (srhRes.response?.records || []).filter((r: any) => r.userId === userId);

    (summary as any).devices = userDevices;
    (summary as any).srh = userSrh;

    // Enrich recent connections with exact route pathway
    (summary as any).recent_connections = (summary.recent_connections || []).map((rc: any) => {
      const res = resolveConnectionNodes(
        rc.inbound,
        rc.outbound,
        rc.node || "local",
        nodes,
        (summary.user?.connected_node as string) || undefined,
        profiles
      );
      return {
        ...rc,
        hops: res.hops,
        is_direct: res.isDirect,
        ingress_node: res.ingressShortName,
        ingress_type: res.ingressType,
        involved_nodes: res.involved,
        node_path: res.nodePath,
        detailed_pathway: res.detailedPathway,
      };
    });
  } catch (err: any) {
    (summary as any).devices = [];
    (summary as any).srh = [];
  }

  return c.json(summary);
});

app.get("/api/domain/:domain{.*}", (c) => {
  const domain = c.req.param("domain");
  const hours = parseInt(c.req.query("hours") || "24", 10);

  return c.json(queryDomainDetail(domain, hours));
});

app.get("/api/live-stream", async (c) => {
  const limit = parseInt(c.req.query("limit") || "50", 10);
  const userIdStr = c.req.query("user_id");
  const userId = userIdStr ? parseInt(userIdStr, 10) : undefined;
  const search = c.req.query("search") || undefined;
  const node = c.req.query("node") || undefined;

  const stream = queryLiveStream(limit, userId, search, node);
  const [nodes, profiles] = await Promise.all([
    getRemnawaveNodes(),
    getRemnawaveConfigProfiles(),
  ]);

  const enriched = stream.map((item: any) => {
    const res = resolveConnectionNodes(
      item.inbound,
      item.outbound,
      item.node || collector.getLocalNodeName(),
      nodes,
      item.connected_node,
      profiles
    );
    return {
      ...item,
      hops: res.hops,
      is_direct: res.isDirect,
      ingress_node: res.ingressShortName,
      ingress_type: res.ingressType,
      involved_nodes: res.involved,
      node_path: res.nodePath,
      detailed_pathway: res.detailedPathway,
    };
  });

  return c.json(enriched);
});

// Webhook / API Ingestion endpoint for remote nodes (xray-monitor-node)
app.post("/api/ingest", async (c) => {
  try {
    const authHeader = c.req.header("X-Ingest-Key") || c.req.header("Authorization");
    const expectedKey = process.env.INGEST_SECRET;
    if (!expectedKey) {
      return c.json({ error: "Server INGEST_SECRET is not configured." }, 500);
    }
    if (!authHeader || (!authHeader.includes(expectedKey) && authHeader !== expectedKey)) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    const body = (await c.req.json()) as any;
    const nodeName = body.node || "remote";
    const role = body.role || "BRIDGE";

    if (body.connections && Array.isArray(body.connections)) {
      collector.ingestNodeBatch(nodeName, role, body.connections);
      return c.json({ status: "ok", processed: body.connections.length });
    }

    if (body.lines && Array.isArray(body.lines)) {
      collector.ingestLines(body.lines, nodeName);
      return c.json({ status: "ok", processed: body.lines.length });
    }

    return c.json({ error: "Invalid payload. Expected connections or lines array." }, 400);
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// 1. HWID Inspector
app.get("/api/remna/hwid", async (c) => {
  try {
    const [devicesData, statsData, topUsersData] = await Promise.all([
      remnaFetch("/hwid/devices?size=200").catch(() => ({ response: { devices: [], total: 0 } })),
      remnaFetch("/hwid/devices/stats").catch(() => ({ response: { byPlatform: [] } })),
      remnaFetch("/hwid/devices/top-users").catch(() => ({ response: { users: [] } })),
    ]);
    return c.json({
      devices: devicesData.response?.devices || [],
      total: devicesData.response?.total || 0,
      stats: statsData.response || {},
      top_users: topUsersData.response?.users || [],
    });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// 2. SRH Inspector (Subscription Request History)
app.get("/api/remna/srh", async (c) => {
  try {
    const [historyData, statsData] = await Promise.all([
      remnaFetch("/subscription-request-history?size=200").catch(() => ({ response: { records: [], total: 0 } })),
      remnaFetch("/subscription-request-history/stats").catch(() => ({ response: { byParsedApp: [] } })),
    ]);
    return c.json({
      records: historyData.response?.records || [],
      total: historyData.response?.total || 0,
      stats: statsData.response || {},
    });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// 3. Session Exploration (Live Nodes & Active Sessions with Dynamic Remnawave Roles & Rules)
app.get("/api/remna/sessions", async (c) => {
  try {
    const [metricsData, dynamicNodes] = await Promise.all([
      remnaFetch("/system/nodes/metrics").catch(() => ({ response: { nodes: [] } })),
      getRemnawaveNodes(),
    ]);

    const allMetrics = metricsData.response?.nodes || [];
    const dynamicMap = new Map(dynamicNodes.map((n) => [n.name, n]));

    const enrichedNodes = allMetrics.map((m: any) => {
      const dyn = dynamicMap.get(m.nodeName) || {
        name: m.nodeName,
        shortName: m.nodeName.split("-")[0] || m.nodeName,
        tags: [],
        role: "OTHER",
        rule: "Node managed via Remnawave.",
        activeInbounds: [],
      };

      const agent = collector.getAgentInfo(m.nodeName) || {
        is_tracked: false,
        name: m.nodeName,
        role: dyn.role,
        status: "NOT_CONFIGURED",
        last_seen_iso: "",
        last_seen_seconds_ago: -1,
        total_batches: 0,
        total_connections: 0,
      };

      return {
        ...m,
        role: dyn.role,
        tags: dyn.tags,
        shortName: dyn.shortName,
        rule: dyn.rule,
        activeInboundsCount: dyn.activeInbounds.length || (m.inboundsStats?.length || 0),
        agent,
      };
    });

    return c.json({ nodes: enrichedNodes });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// 4. Remnawave Bandwidth & Daily/Monthly/Yearly Trends (Dynamic Egress Filtering)
app.get("/api/remna/bandwidth", async (c) => {
  try {
    const range = c.req.query("range") || "7d";
    const now = new Date();
    const end = now.toISOString().slice(0, 10);
    let days = 7;
    if (range === "30d" || range === "monthly") days = 30;
    else if (range === "90d") days = 90;
    else if (range === "365d" || range === "yearly") days = 365;

    const start = new Date(now.getTime() - days * 86400000).toISOString().slice(0, 10);

    const [bwData, rangeData, recapData, nodes] = await Promise.all([
      remnaFetch("/system/stats/bandwidth").catch(() => ({ response: {} })),
      remnaFetch(`/bandwidth-stats/nodes?start=${start}&end=${end}`).catch(() => ({ response: {} })),
      remnaFetch("/system/stats/recap").catch(() => ({ response: {} })),
      getRemnawaveNodes(),
    ]);

    const tunnelNames = new Set(nodes.filter((n) => n.role === "TUNNEL").map((n) => n.name.toLowerCase()));

    // Filter out any TUNNEL nodes dynamically from series
    const series = (rangeData.response?.series || []).filter(
      (s: any) => !tunnelNames.has(s.name.toLowerCase())
    );
    const categories = rangeData.response?.categories || [];

    return c.json({
      bandwidth: bwData.response || {},
      series,
      categories,
      days,
      recap: recapData.response || {},
    });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

const PORT = parseInt(process.env.PORT || "9922", 10);
serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`[Server] Remnawave Traffic Monitor listening on http://127.0.0.1:${info.port}`);
});
