import { execSync } from "node:child_process";
import {
  initDatabase,
  insertBatch,
  syncUsers,
  purgeExcludedUsers,
  cleanupOldData,
  recordInboundTrafficDelta,
  formatBytes,
  type ConnectionRecord,
  type UserSyncRecord,
} from "./database";
import {
  getRemnawaveNodes,
  detectLocalNode,
  isBridgeRole,
  type RemnaNode,
} from "./topology";

const envExcludedIds = (process.env.EXCLUDED_USER_IDS || "")
  .split(",")
  .map((s) => parseInt(s.trim(), 10))
  .filter((n) => !isNaN(n));

export const EXCLUDED_USER_IDS = new Set<number>(envExcludedIds);
export const EXCLUDED_USERNAMES = new Set<string>(["tunnel"]);

// Regex matching Xray connection log lines
const LOG_PATTERN =
  /^(\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?) (?:from )?(?:[a-z0-9]+:)?([^\s]+) accepted ([a-z0-9]+):([^:]+):(\d+) \[([^ \]]+)(?: -> ([^\]]+))?\] email: (\S+)/;

const IPV4_REGEX = /^(?:\d{1,3}\.){3}\d{1,3}$/;

export function classifyDestination(dest: string): [string, string] {
  const destLower = dest.toLowerCase().trim();

  // Check IPv4
  if (IPV4_REGEX.test(destLower)) {
    if (destLower.startsWith("149.154.") || destLower.startsWith("91.108.")) {
      return ["telegram.org", "Telegram"];
    }
    if (
      destLower.startsWith("157.240.") ||
      destLower.startsWith("31.13.") ||
      destLower.startsWith("179.60.") ||
      destLower.startsWith("57.144.") ||
      destLower.startsWith("185.60.") ||
      destLower.startsWith("69.171.") ||
      destLower.startsWith("129.134.")
    ) {
      return ["instagram.com", "Instagram / Meta"];
    }
    if (destLower.startsWith("17.")) {
      return ["apple.com", "Apple"];
    }
    if (
      destLower === "8.8.8.8" ||
      destLower === "8.8.4.4" ||
      destLower.startsWith("142.250.") ||
      destLower.startsWith("142.251.") ||
      destLower.startsWith("172.217.") ||
      destLower.startsWith("216.239.") ||
      destLower.startsWith("74.125.") ||
      destLower.startsWith("64.233.") ||
      destLower.startsWith("66.102.") ||
      destLower.startsWith("66.249.") ||
      destLower.startsWith("34.") ||
      destLower.startsWith("35.")
    ) {
      return ["google.com", "Google / YouTube"];
    }
    if (
      destLower.startsWith("3.") ||
      destLower.startsWith("18.") ||
      destLower.startsWith("52.") ||
      destLower.startsWith("54.") ||
      destLower.startsWith("15.") ||
      destLower.startsWith("16.") ||
      destLower.startsWith("44.") ||
      destLower.startsWith("99.")
    ) {
      return ["aws.amazon.com", "Amazon AWS"];
    }
    if (
      destLower === "1.1.1.1" ||
      destLower === "1.0.0.1" ||
      destLower.startsWith("104.16.") ||
      destLower.startsWith("104.17.") ||
      destLower.startsWith("104.18.") ||
      destLower.startsWith("104.19.") ||
      destLower.startsWith("104.20.") ||
      destLower.startsWith("104.21.") ||
      destLower.startsWith("104.22.") ||
      destLower.startsWith("104.23.") ||
      destLower.startsWith("104.24.") ||
      destLower.startsWith("172.64.") ||
      destLower.startsWith("172.65.") ||
      destLower.startsWith("172.66.") ||
      destLower.startsWith("172.67.") ||
      destLower.startsWith("162.158.") ||
      destLower.startsWith("162.159.") ||
      destLower.startsWith("108.162.") ||
      destLower.startsWith("198.41.") ||
      destLower.startsWith("188.114.")
    ) {
      return ["cloudflare.com", "Cloudflare"];
    }
    if (destLower.startsWith("151.101.") || destLower.startsWith("199.232.")) {
      return ["fastly.net", "Fastly CDN"];
    }
    if (
      destLower.startsWith("20.") ||
      destLower.startsWith("40.") ||
      destLower.startsWith("51.") ||
      destLower.startsWith("13.")
    ) {
      return ["microsoft.com", "Microsoft / Azure"];
    }
    if (destLower.startsWith("104.244.")) {
      return ["x.com", "X (Twitter)"];
    }
    if (
      destLower.startsWith("159.69.") ||
      destLower.startsWith("116.203.") ||
      destLower.startsWith("168.119.") ||
      destLower.startsWith("135.181.")
    ) {
      return ["hetzner.com", "Hetzner Cloud"];
    }
    if (
      destLower.startsWith("134.209.") ||
      destLower.startsWith("138.68.") ||
      destLower.startsWith("159.89.") ||
      destLower.startsWith("165.227.") ||
      destLower.startsWith("167.99.") ||
      destLower.startsWith("178.62.")
    ) {
      return ["digitalocean.com", "DigitalOcean"];
    }
    return [destLower, "Direct IP"];
  }

  // Domain parsing
  const parts = destLower.split(".");
  let root = destLower;
  if (parts.length >= 2) {
    const secondLast = parts[parts.length - 2] || "";
    const last = parts[parts.length - 1] || "";
    if (
      parts.length >= 3 &&
      ["co", "com", "org", "net", "gov", "edu", "ac", "im", "ir"].includes(secondLast) &&
      last.length <= 3
    ) {
      root = parts.slice(-3).join(".");
    } else {
      root = parts.slice(-2).join(".");
    }
  }

  let cat = "General";
  if (["google", "youtube", "googlevideo", "ytimg", "gstatic", "gmail", "android"].some((k) => root.includes(k))) {
    cat = "Google / YouTube";
  } else if (["instagram", "facebook", "fbcdn", "whatsapp", "threads", "fbsbx"].some((k) => root.includes(k))) {
    cat = "Instagram / Meta";
  } else if (["telegram", "t.me", "telegra.ph", "tdesktop"].some((k) => root.includes(k))) {
    cat = "Telegram";
  } else if (["apple", "icloud", "mzstatic", "aaplimg"].some((k) => root.includes(k))) {
    cat = "Apple";
  } else if (["twitter", "x.com", "twimg", "t.co"].some((k) => root.includes(k))) {
    cat = "X (Twitter)";
  } else if (["microsoft", "azure", "office", "live.com", "bing", "windows.net"].some((k) => root.includes(k))) {
    cat = "Microsoft / Azure";
  } else if (["amazon", "aws", "cloudfront"].some((k) => root.includes(k))) {
    cat = "Amazon / AWS";
  } else if (["openai", "chatgpt", "oaistatic"].some((k) => root.includes(k))) {
    cat = "OpenAI";
  } else if (["tiktok", "byteoversea", "ibytedtos"].some((k) => root.includes(k))) {
    cat = "TikTok";
  } else if (["spotify", "scdn.co"].some((k) => root.includes(k))) {
    cat = "Spotify";
  } else if (["netflix", "nflxvideo"].some((k) => root.includes(k))) {
    cat = "Netflix";
  } else if (root.includes("cloudflare")) {
    cat = "Cloudflare";
  }

  return [root, cat];
}

export interface NodeAgentInfo {
  is_tracked: boolean;
  name: string;
  role: "BRIDGE" | "TUNNEL";
  status: "ACTIVE" | "OFFLINE";
  last_seen_iso: string;
  last_seen_seconds_ago: number;
  total_batches: number;
  total_connections: number;
}

export class XrayCollector {
  private buffer: ConnectionRecord[] = [];
  private isRunning: boolean = true;
  private localNodeName: string = "BRIDGE";
  private knownNodes: RemnaNode[] = [];
  private agents = new Map<
    string,
    {
      name: string;
      role: "BRIDGE" | "TUNNEL";
      lastSeen: Date;
      totalBatches: number;
      totalConnections: number;
    }
  >();
  private tunnelIps = new Set<string>();

  public recordAgentHeartbeat(nodeName: string, role: string, count: number) {
    const normRole = (role === "TUNNEL" ? "TUNNEL" : "BRIDGE") as "BRIDGE" | "TUNNEL";
    const existing = this.agents.get(nodeName);
    if (existing) {
      existing.lastSeen = new Date();
      existing.totalBatches += 1;
      existing.totalConnections += count;
      existing.role = normRole;
    } else {
      this.agents.set(nodeName, {
        name: nodeName,
        role: normRole,
        lastSeen: new Date(),
        totalBatches: 1,
        totalConnections: count,
      });
    }
  }

  public getAgentInfo(nodeName: string): NodeAgentInfo | null {
    for (const [name, agent] of this.agents.entries()) {
      if (
        name.toLowerCase() === nodeName.toLowerCase() ||
        nodeName.toLowerCase().includes(name.toLowerCase()) ||
        name.toLowerCase().includes(nodeName.toLowerCase())
      ) {
        const secAgo = Math.round((Date.now() - agent.lastSeen.getTime()) / 1000);
        return {
          is_tracked: true,
          name: agent.name,
          role: agent.role,
          status: secAgo <= 90 ? "ACTIVE" : "OFFLINE",
          last_seen_iso: agent.lastSeen.toISOString(),
          last_seen_seconds_ago: secAgo,
          total_batches: agent.totalBatches,
          total_connections: agent.totalConnections,
        };
      }
    }
    return null;
  }

  public getAllAgents(): NodeAgentInfo[] {
    const list: NodeAgentInfo[] = [];
    for (const agent of this.agents.values()) {
      const secAgo = Math.round((Date.now() - agent.lastSeen.getTime()) / 1000);
      list.push({
        is_tracked: true,
        name: agent.name,
        role: agent.role,
        status: secAgo <= 90 ? "ACTIVE" : "OFFLINE",
        last_seen_iso: agent.lastSeen.toISOString(),
        last_seen_seconds_ago: secAgo,
        total_batches: agent.totalBatches,
        total_connections: agent.totalConnections,
      });
    }
    return list;
  }

  public setLocalNodeName(name: string) {
    this.localNodeName = name;
  }

  public getLocalNodeName(): string {
    return this.localNodeName;
  }

  public addLogLine(rawLine: string, node?: string) {
    const trimmed = rawLine.trim();
    if (!trimmed) return;

    const targetNode = node || this.localNodeName;

    // Architectural Rule: Only nodes configured as BRIDGE in Remnawave record connection destinations
    if (this.knownNodes.length > 0 && !isBridgeRole(targetNode, this.knownNodes)) {
      return;
    }

    const match = LOG_PATTERN.exec(trimmed);
    if (!match) return;

    const rawTs = match[1] || "";
    const proto = match[3] || "tcp";
    const dest = match[4] || "";
    const portStr = match[5] || "443";
    const inbound = match[6] || "in-default";
    const outbound = match[7] || "direct";
    const userIdStr = match[8] || "";

    const userId = parseInt(userIdStr, 10);
    if (isNaN(userId) || EXCLUDED_USER_IDS.has(userId)) return;

    const port = parseInt(portStr, 10);
    const tsFormatted = rawTs.replaceAll("/", "-").split(".")[0] || "";
    const [rootDomain, category] = classifyDestination(dest);

    this.buffer.push({
      ts: tsFormatted,
      user_id: userId,
      proto,
      dest,
      root_domain: rootDomain,
      category,
      port,
      inbound,
      outbound,
      node: targetNode,
    });
  }

  public ingestLines(lines: string[], node?: string) {
    for (const l of lines) {
      this.addLogLine(l, node);
    }
  }

  public ingestNodeBatch(nodeName: string, role: string, connections: any[]) {
    this.recordAgentHeartbeat(nodeName, role, connections.length);

    for (const item of connections) {
      const userId = parseInt(item.email, 10);
      if (isNaN(userId) || EXCLUDED_USER_IDS.has(userId)) continue;

      // Deduplication:
      // If report is from BRIDGE and client_ip is from a known TUNNEL,
      // it is a transit packet forwarded from the tunnel. Skip to avoid double counting!
      if (role === "BRIDGE") {
        if (this.tunnelIps.has(item.client_ip)) {
          continue;
        }
      }

      const port = parseInt(item.port, 10);
      const tsFormatted = (item.ts || "").replaceAll("/", "-").split(".")[0];
      const [rootDomain, category] = classifyDestination(item.dest);
      const cleanInbound = item.inbound || (role === "TUNNEL" ? "in-default-loop" : "in-default");

      this.buffer.push({
        ts: tsFormatted,
        user_id: userId,
        proto: item.proto || "tcp",
        dest: item.dest,
        root_domain: rootDomain,
        category,
        port: isNaN(port) ? 443 : port,
        inbound: cleanInbound,
        outbound: item.outbound || (role === "TUNNEL" ? "bridge-out" : "direct"),
        node: nodeName,
      });
    }
  }

  private startFlushTimer() {
    setInterval(() => {
      if (this.buffer.length === 0) return;
      const recordsToInsert = this.buffer;
      this.buffer = [];
      try {
        insertBatch(recordsToInsert);
      } catch (err) {
        console.error("Batch insert error:", err);
      }
    }, 1500);
  }

  /**
   * Syncs user details cleanly via Remnawave REST API over HTTPS.
   * No SSH or direct database calls.
   */
  public async syncRemnawaveUsers() {
    const apiUrl = process.env.REMNAWAVE_API_URL || "https://panel.example.com/api";
    const apiToken = process.env.REMNAWAVE_API_TOKEN;

    if (!apiToken) {
      console.warn("[Collector] REMNAWAVE_API_TOKEN is not configured in .env");
      return;
    }

    try {
      const response = await fetch(`${apiUrl}/users?size=500`, {
        headers: {
          Authorization: `Bearer ${apiToken}`,
          Accept: "application/json",
        },
      });

      if (!response.ok) {
        console.warn(`[Collector] Remnawave REST API error: HTTP ${response.status} ${response.statusText}`);
        return;
      }

      const data = (await response.json()) as {
        response?: {
          users?: Array<{
            id: number;
            username: string;
            status?: string;
            userTraffic?: { lastConnectedNodeUuid?: string; onlineAt?: string };
          }>;
        };
      };

      // 1. Sync node topology dynamically from Remnawave API first
      const nodes = await getRemnawaveNodes(true);
      this.knownNodes = nodes;
      this.tunnelIps = new Set(
        nodes
          .filter((n) => n.role === "TUNNEL" || (n.tags && n.tags.includes("TUNNEL")))
          .map((n) => n.address)
          .filter(Boolean)
      );
      const local = detectLocalNode(nodes);
      if (local) {
        this.localNodeName = local.name;
        console.log(`[Collector] Dynamic local node set from Remnawave API: ${local.name} (${local.address}) [${local.role}]`);
      }

      const rawUsers = data.response?.users || [];
      if (rawUsers.length > 0) {
        for (const u of rawUsers) {
          if (u.username === "tunnel" || EXCLUDED_USERNAMES.has(u.username)) {
            EXCLUDED_USER_IDS.add(u.id);
          }
        }
        purgeExcludedUsers(Array.from(EXCLUDED_USER_IDS));

        const users: UserSyncRecord[] = rawUsers
          .filter((u) => !EXCLUDED_USER_IDS.has(u.id) && !EXCLUDED_USERNAMES.has(u.username))
          .map((u) => {
            const nodeUuid = u.userTraffic?.lastConnectedNodeUuid;
            const matched = nodes.find((n) => n.uuid === nodeUuid || String(n.id) === String(nodeUuid));
            const connected_node = matched ? matched.shortName : (u.userTraffic?.onlineAt ? "DE1" : "");
            return {
              id: u.id,
              username: u.username,
              status: u.status || "ACTIVE",
              connected_node,
            };
          });
        syncUsers(users);
        console.log(
          `[Collector] Successfully synced ${users.length} users with ingress node topology (excluded tunnel IDs: ${Array.from(EXCLUDED_USER_IDS).join(",")})`
        );
      }
    } catch (err) {
      console.warn("[Collector] Failed to sync users or nodes from Remnawave API:", err);
    }
  }

  private startUsersSyncTimer() {
    this.syncRemnawaveUsers();
    setInterval(() => {
      this.syncRemnawaveUsers();
    }, 5 * 60 * 1000);
  }

  private startCleanupTimer() {
    cleanupOldData(48, 60);
    setInterval(() => {
      cleanupOldData(48, 60);
      console.log("[Collector] Routine cleanup finished");
    }, 60 * 60 * 1000);
  }

  private lastInboundStats = new Map<string, { uplink: number; downlink: number }>();

  public queryXrayLiveStats(): {
    inbound: string;
    uplink_bytes: number;
    downlink_bytes: number;
    total_bytes: number;
    uplink_formatted: string;
    downlink_formatted: string;
    total_formatted: string;
  }[] {
    try {
      const pid = execSync("pidof xray 2>/dev/null", { encoding: "utf8" }).trim().split(/\s+/)[0];
      if (!pid || !/^\d+$/.test(pid)) return [];

      const out = execSync(
        `nsenter -t ${pid} -n /usr/local/bin/xray api statsquery -s "unix:@xtls-api-a15D2PSZsh" -pattern "inbound"`,
        { encoding: "utf8", timeout: 2000 }
      );
      const data = JSON.parse(out);
      const raw = data.stat || [];
      const map = new Map<string, { inbound: string; uplink: number; downlink: number }>();

      for (const item of raw) {
        const parts = item.name.split(">>>");
        if (parts.length >= 4 && parts[0] === "inbound" && parts[2] === "traffic") {
          const tag = parts[1];
          if (tag === "REMNAWAVE_API_INBOUND") continue;
          const dir = parts[3];
          const val = item.value || 0;
          if (!map.has(tag)) map.set(tag, { inbound: tag, uplink: 0, downlink: 0 });
          const entry = map.get(tag)!;
          if (dir === "uplink") entry.uplink = val;
          if (dir === "downlink") entry.downlink = val;
        }
      }

      return Array.from(map.values()).map((e) => ({
        inbound: e.inbound,
        uplink_bytes: e.uplink,
        downlink_bytes: e.downlink,
        total_bytes: e.uplink + e.downlink,
        uplink_formatted: formatBytes(e.uplink),
        downlink_formatted: formatBytes(e.downlink),
        total_formatted: formatBytes(e.uplink + e.downlink),
      }));
    } catch {
      return [];
    }
  }

  private startTrafficStatsTimer() {
    // Poll immediately and then every 10 seconds
    const poll = () => {
      try {
        const stats = this.queryXrayLiveStats();
        const now = new Date();
        const hourBucket = now.toISOString().slice(0, 13) + ":00:00";

        for (const s of stats) {
          const prev = this.lastInboundStats.get(s.inbound);
          if (prev) {
            const upDelta = s.uplink_bytes >= prev.uplink ? s.uplink_bytes - prev.uplink : s.uplink_bytes;
            const downDelta = s.downlink_bytes >= prev.downlink ? s.downlink_bytes - prev.downlink : s.downlink_bytes;
            if (upDelta > 0 || downDelta > 0) {
              recordInboundTrafficDelta(hourBucket, this.localNodeName, s.inbound, upDelta, downDelta);
            }
          }
          this.lastInboundStats.set(s.inbound, { uplink: s.uplink_bytes, downlink: s.downlink_bytes });
        }
      } catch (err) {
        // ignore occasional query blips
      }
    };

    poll();
    setInterval(poll, 10000);
  }

  public start() {
    initDatabase();
    this.startFlushTimer();
    this.startUsersSyncTimer();
    this.startCleanupTimer();
    this.startTrafficStatsTimer();
    // Central aggregator mode: All telemetry is ingested cleanly via xray-monitor-node agents (no direct local file coupling)
    console.log("[Collector] Central Telemetry Collector & Remnawave API sync started (Distributed Agent Mode)");
  }

  public stop() {
    this.isRunning = false;
  }
}
