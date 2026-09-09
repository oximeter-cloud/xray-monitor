import { networkInterfaces } from "node:os";

export interface InboundConfig {
  tag: string;
  port?: number;
  type?: string;
  network?: string;
  path?: string;
}

export interface RemnaNode {
  uuid: string;
  id: number;
  name: string;
  shortName: string;
  address: string;
  countryCode: string;
  tags: string[];
  role: "TUNNEL" | "BRIDGE" | "OUTBOUND" | "OTHER";
  rule: string;
  activeInbounds: InboundConfig[];
}

export interface HopInfo {
  nodeName: string;
  shortName: string;
  role: "TUNNEL" | "BRIDGE" | "OUTBOUND" | "DIRECT" | "OTHER";
  tag: string;
  port?: number;
}

export interface ResolvedPathway {
  hops: HopInfo[];
  isDirect: boolean;
  ingressShortName: string;
  ingressType: "DIRECT" | "TUNNEL";
  involved: Array<{ role: string; name: string; shortName: string }>;
  nodePath: string;
  detailedPathway: string;
}

export interface XrayRule {
  inboundTag: string[];
  outboundTag: string;
}

export interface XrayOutbound {
  tag: string;
  protocol: string;
  settings?: {
    address?: string;
    port?: number;
    [key: string]: any;
  };
  streamSettings?: {
    network?: string;
    security?: string;
    wsSettings?: {
      path?: string;
      [key: string]: any;
    };
    tlsSettings?: {
      serverName?: string;
      [key: string]: any;
    };
    [key: string]: any;
  };
}

export interface ConfigProfile {
  uuid: string;
  name: string;
  config: {
    routing?: {
      rules?: XrayRule[];
      [key: string]: any;
    };
    inbounds?: any[];
    outbounds?: XrayOutbound[];
    [key: string]: any;
  };
  nodes?: Array<{ uuid: string; name: string }>;
}

let cachedNodes: RemnaNode[] = [];
let cachedProfiles: ConfigProfile[] = [];
let lastFetchTime = 0;

export function getLocalHostIps(): Set<string> {
  const ips = new Set<string>();
  const nets = networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (!net.internal && net.family === "IPv4") {
        ips.add(net.address);
      }
    }
  }
  return ips;
}

export async function getRemnawaveNodes(forceRefresh: boolean = false): Promise<RemnaNode[]> {
  const now = Date.now();
  if (!forceRefresh && cachedNodes.length > 0 && now - lastFetchTime < 60000) {
    return cachedNodes;
  }

  const apiUrl = process.env.REMNAWAVE_API_URL || "https://panel.example.com/api";
  const apiToken = process.env.REMNAWAVE_API_TOKEN;

  try {
    const res = await fetch(`${apiUrl}/nodes`, {
      headers: { Authorization: `Bearer ${apiToken}`, Accept: "application/json" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { response: any[] };

    cachedNodes = (data.response || []).map((n: any) => {
      const tags: string[] = (n.tags || []).map((t: string) => t.toLowerCase());
      const rawName: string = n.name || "Unknown";
      const shortName = (rawName.split("-")[0] || rawName).toUpperCase();

      let role: "TUNNEL" | "BRIDGE" | "OUTBOUND" | "OTHER" = "OTHER";
      if (
        tags.includes("tunnel") ||
        tags.includes("iran") ||
        rawName.toLowerCase().includes("iran") ||
        rawName.toLowerCase().includes("ir")
      ) {
        role = "TUNNEL";
      } else if (
        tags.includes("bridge") ||
        tags.includes("core") ||
        rawName.toLowerCase().includes("de") ||
        rawName.toLowerCase().includes("germany")
      ) {
        role = "BRIDGE";
      } else if (
        tags.includes("outbound") ||
        tags.includes("outbund") ||
        tags.includes("exit") ||
        rawName.toLowerCase().includes("fi") ||
        rawName.toLowerCase().includes("finland")
      ) {
        role = "OUTBOUND";
      } else {
        role = "OUTBOUND";
      }

      const rule =
        n.notes ||
        (role === "TUNNEL"
          ? "Ingress entrance proxy. Forwarding tunnel entry into bridge nodes."
          : role === "BRIDGE"
            ? "Core central gateway & bridge. Full DPI, destination domain analysis, DNS sniffing, and user connection matrix."
            : "Outbound exit node. Handles final egress internet routing.");

      const activeInbounds: InboundConfig[] = (n.configProfile?.activeInbounds || []).map((ib: any) => {
        const raw = ib.rawInbound || {};
        const stream = raw.streamSettings || {};
        const ws = stream.wsSettings || {};
        return {
          tag: ib.tag,
          port: ib.port ? parseInt(ib.port, 10) : undefined,
          type: ib.type || raw.protocol || "unknown",
          network: ib.network || stream.network || "tcp",
          path: ws.path || undefined,
        };
      });

      return {
        uuid: n.uuid || "",
        id: n.id,
        name: n.name,
        shortName,
        address: n.address,
        countryCode: n.countryCode || "",
        tags: tags.length > 0 ? tags : [role],
        role,
        rule,
        activeInbounds,
      };
    });

    lastFetchTime = now;
  } catch (err) {
    console.warn("[Topology] Failed to fetch nodes from Remnawave API:", err);
  }

  return cachedNodes;
}

export async function getRemnawaveConfigProfiles(forceRefresh: boolean = false): Promise<ConfigProfile[]> {
  const now = Date.now();
  if (!forceRefresh && cachedProfiles.length > 0 && now - lastFetchTime < 60000) {
    return cachedProfiles;
  }

  const apiUrl = process.env.REMNAWAVE_API_URL || "https://panel.example.com/api";
  const apiToken = process.env.REMNAWAVE_API_TOKEN;

  try {
    const res = await fetch(`${apiUrl}/config-profiles`, {
      headers: { Authorization: `Bearer ${apiToken}`, Accept: "application/json" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { response?: { configProfiles?: ConfigProfile[] } };
    cachedProfiles = data.response?.configProfiles || [];
  } catch (err) {
    console.warn("[Topology] Failed to fetch config profiles from Remnawave API:", err);
  }

  return cachedProfiles;
}

export function detectLocalNode(nodes: RemnaNode[]): RemnaNode | undefined {
  const localIps = getLocalHostIps();
  return nodes.find((n) => localIps.has(n.address) || n.address === process.env.LOCAL_NODE_IP);
}

export function isBridgeRole(nodeName: string, nodes: RemnaNode[]): boolean {
  const found = nodes.find((n) => n.name === nodeName || n.shortName === nodeName);
  if (found) return found.role === "BRIDGE";
  const lower = nodeName.toLowerCase();
  return !lower.includes("tunnel") && !lower.includes("iran") && !lower.includes("outbound");
}

/**
 * Builds a dynamic map of which Tunnel inbounds forward into which Bridge inbounds
 * based on actual Xray config outbounds & routing rules.
 * e.g. "bridge-default-out" (path: /api/v1/play) -> "in-default" (path: /api/v1/play)
 */
export function buildTunnelToBridgeInboundMap(profiles: ConfigProfile[]): Map<string, string> {
  const tunnelProf = profiles.find((p) => p.name === "tunnel" || p.name.toLowerCase().includes("tunnel"));
  const bridgeProf = profiles.find((p) => p.name === "bridge" || p.name.toLowerCase().includes("bridge"));

  const map = new Map<string, string>();
  if (!tunnelProf || !bridgeProf) return map;

  const tunnelOutbounds = tunnelProf.config?.outbounds || [];
  const bridgeInbounds = bridgeProf.config?.inbounds || [];
  const tunnelRules = tunnelProf.config?.routing?.rules || [];

  // 1. Map tunnel outbound tag -> bridge inbound tag
  const outToBridgeIn = new Map<string, string>();
  for (const o of tunnelOutbounds) {
    const path = o.streamSettings?.wsSettings?.path;
    const sName = o.streamSettings?.tlsSettings?.serverName?.toLowerCase() || "";

    // Check if this outbound targets the bridge node
    if (o.tag.startsWith("bridge-") || sName.includes("de") || sName.includes("bridge")) {
      const match = bridgeInbounds.find((ib) => {
        const ibPath = ib.streamSettings?.wsSettings?.path;
        return (path && ibPath && path === ibPath) || ib.tag === o.tag.replace(/^bridge-/, "").replace(/-out$/, "");
      });

      if (match) {
        outToBridgeIn.set(o.tag, match.tag);
      }
    }
  }

  // 2. Map tunnel inbound tag -> bridge inbound tag
  for (const r of tunnelRules) {
    const targetBridgeIn = outToBridgeIn.get(r.outboundTag);
    if (targetBridgeIn && Array.isArray(r.inboundTag)) {
      for (const inTag of r.inboundTag) {
        map.set(inTag, targetBridgeIn);
      }
    }
  }

  return map;
}

/**
 * Returns all tunnel inbound tags that forward to a specific bridge inbound tag
 */
export function getFeedingTunnelInbounds(profiles: ConfigProfile[], bridgeInboundTag: string): string[] {
  const map = buildTunnelToBridgeInboundMap(profiles);
  const feeders: string[] = [];
  for (const [tunnelIn, bridgeIn] of map.entries()) {
    if (bridgeIn === bridgeInboundTag) {
      feeders.push(tunnelIn);
    }
  }
  return feeders;
}

/**
 * Exact Xray Config-driven Auto-Topology & Route Pathway Discovery
 * Uses actual Xray routing rules and outbounds fetched directly from Remnawave API.
 */
export function resolveConnectionNodes(
  inbound: string,
  outbound: string,
  processingNodeName: string,
  nodes: RemnaNode[],
  userConnectedNode?: string,
  profiles: ConfigProfile[] = cachedProfiles
): ResolvedPathway {
  if (!nodes || nodes.length === 0) {
    const defaultHop: HopInfo = {
      nodeName: processingNodeName || "DE1-Oximeter",
      shortName: (processingNodeName || "DE1").split("-")[0]!.toUpperCase(),
      role: "BRIDGE",
      tag: inbound || "unknown",
    };
    return {
      hops: [defaultHop],
      isDirect: true,
      ingressShortName: defaultHop.shortName,
      ingressType: "DIRECT",
      involved: [{ role: defaultHop.role, name: defaultHop.nodeName, shortName: defaultHop.shortName }],
      nodePath: defaultHop.shortName,
      detailedPathway: `${defaultHop.shortName}: ${inbound} → ${outbound || "direct"}`,
    };
  }

  // 1. Identify origin node
  let originNode = nodes.find(
    (n) =>
      n.name.toLowerCase() === processingNodeName.toLowerCase() ||
      n.shortName.toLowerCase() === processingNodeName.toLowerCase()
  );

  if (!originNode) {
    const owner = nodes.find((n) => n.activeInbounds.some((ib) => ib.tag === inbound));
    originNode = owner || nodes.find((n) => n.role === "BRIDGE") || nodes[0]!;
  }

  // Find node's config profile
  const originProfile = profiles.find((p) =>
    p.nodes?.some((pn) => pn.name === originNode!.name || pn.uuid === originNode!.uuid) ||
    p.name.toLowerCase() === originNode!.role.toLowerCase() ||
    p.name.toLowerCase().includes(originNode!.shortName.toLowerCase())
  );

  // 2. Check routing rule for inbound on origin node
  const rules = originProfile?.config?.routing?.rules || [];
  const matchingRule = rules.find((r) => Array.isArray(r.inboundTag) && r.inboundTag.includes(inbound));
  const configuredOutboundTag = matchingRule?.outboundTag;

  const originOutbounds = originProfile?.config?.outbounds || [];
  const outboundConfig = originOutbounds.find((o) => o.tag === configuredOutboundTag);

  const hops: HopInfo[] = [];

  // Case A: Origin is a TUNNEL node
  if (originNode.role === "TUNNEL") {
    hops.push({
      nodeName: originNode.name,
      shortName: originNode.shortName,
      role: "TUNNEL",
      tag: inbound,
    });

    // Check if this outbound forwards to a BRIDGE node
    const isBridgeForward =
      configuredOutboundTag &&
      (configuredOutboundTag.startsWith("bridge-") ||
        outboundConfig?.streamSettings?.tlsSettings?.serverName?.includes("de") ||
        outboundConfig?.streamSettings?.tlsSettings?.serverName?.includes("bridge"));

    if (isBridgeForward) {
      // Find bridge node
      const bridgeNode = nodes.find((n) => n.role === "BRIDGE") || nodes.find((n) => n.shortName === "DE1");
      if (bridgeNode) {
        // Find matching bridge inbound (by path or name)
        const path = outboundConfig?.streamSettings?.wsSettings?.path;
        const bridgeIn = bridgeNode.activeInbounds.find((ib) => {
          return (path && ib.path && path === ib.path) || ib.tag === configuredOutboundTag?.replace(/^bridge-/, "").replace(/-out$/, "");
        });

        const bridgeTag = bridgeIn?.tag || configuredOutboundTag?.replace(/^bridge-/, "").replace(/-out$/, "") || "in-default";

        hops.push({
          nodeName: bridgeNode.name,
          shortName: bridgeNode.shortName,
          role: "BRIDGE",
          tag: bridgeTag,
        });

        // Check if Bridge routes to an OUTBOUND egress node (e.g. FI1)
        const bridgeProfile = profiles.find((p) => p.name === "bridge" || p.name.toLowerCase().includes("bridge"));
        const bridgeRule = bridgeProfile?.config?.routing?.rules?.find(
          (r) => Array.isArray(r.inboundTag) && r.inboundTag.includes(bridgeTag)
        );
        const bridgeOutbound = bridgeRule?.outboundTag;

        if (bridgeOutbound && (bridgeOutbound.includes("finland") || bridgeOutbound.includes("fi1"))) {
          const egressNode = nodes.find((n) => n.role === "OUTBOUND" || n.shortName === "FI1");
          if (egressNode) {
            hops.push({
              nodeName: egressNode.name,
              shortName: egressNode.shortName,
              role: "OUTBOUND",
              tag: egressNode.activeInbounds[0]?.tag || "vless-fi1-in",
            });
          }
        }
      }
    }
    // Else: Direct tunnel connection (e.g. vless-ws-tls-lu2-in -> abr-2-out, vless-ws-tls-lu1-in -> abr-1-out)
    // -> No Bridge hop added! Exits directly from Tunnel!
  } else {
    // Case B: Origin is a BRIDGE node
    // Check if user entered via a tunnel
    const tunnelMap = buildTunnelToBridgeInboundMap(profiles);
    let feedingTunnelTag: string | undefined;

    for (const [tIn, bIn] of tunnelMap.entries()) {
      if (bIn === inbound) {
        feedingTunnelTag = tIn;
        break;
      }
    }

    const isTunneled =
      Boolean(feedingTunnelTag) &&
      (Boolean(userConnectedNode && userConnectedNode.includes("IR")) ||
        inbound.includes("default") ||
        inbound.startsWith("in-"));

    if (isTunneled) {
      const tunnelNode = nodes.find((n) => n.role === "TUNNEL") || nodes.find((n) => n.shortName === "IR1");
      if (tunnelNode) {
        hops.push({
          nodeName: tunnelNode.name,
          shortName: tunnelNode.shortName,
          role: "TUNNEL",
          tag: feedingTunnelTag || `${inbound}-loop`,
        });
      }
    }

    hops.push({
      nodeName: originNode.name,
      shortName: originNode.shortName,
      role: originNode.role,
      tag: inbound,
    });

    // Check if Bridge routes to an OUTBOUND egress node (e.g. FI1)
    if (configuredOutboundTag && (configuredOutboundTag.includes("finland") || configuredOutboundTag.includes("fi1"))) {
      const egressNode = nodes.find((n) => n.role === "OUTBOUND" || n.shortName === "FI1");
      if (egressNode) {
        hops.push({
          nodeName: egressNode.name,
          shortName: egressNode.shortName,
          role: "OUTBOUND",
          tag: egressNode.activeInbounds[0]?.tag || "vless-fi1-in",
        });
      }
    }
  }

  // 3. Output formatting
  const firstHop = hops[0]!;
  const isDirect = firstHop.role !== "TUNNEL";
  const ingressShortName = firstHop.shortName;
  const ingressType: "DIRECT" | "TUNNEL" = isDirect ? "DIRECT" : "TUNNEL";

  const involvedMap = new Map<string, { role: string; name: string; shortName: string }>();
  for (const h of hops) {
    if (!involvedMap.has(h.shortName)) {
      involvedMap.set(h.shortName, {
        role: h.role,
        name: h.nodeName,
        shortName: h.shortName,
      });
    }
  }
  const involved = Array.from(involvedMap.values());
  const nodePath = Array.from(involvedMap.keys()).join(" → ");

  // Final egress outbound label
  const finalOutbound = outbound || configuredOutboundTag || "direct";
  const hopTags = hops.map((h) => `${h.shortName}: ${h.tag}`);
  const detailedPathway = `${hopTags.join(" → ")} → ${finalOutbound}`;

  return {
    hops,
    isDirect,
    ingressShortName,
    ingressType,
    involved,
    nodePath,
    detailedPathway,
  };
}
