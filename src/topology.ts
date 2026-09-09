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

let cachedNodes: RemnaNode[] = [];
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

function normalizeInboundTag(tag: string): string {
  let cleaned = tag.toLowerCase().trim();
  cleaned = cleaned.replace(/-loop$/, "");
  cleaned = cleaned.replace(/-lu\d+/, "");
  return cleaned;
}

function findDownstreamHop(
  sourceNode: RemnaNode,
  sourceInboundTag: string,
  candidateNodes: RemnaNode[]
): { node: RemnaNode; inbound: InboundConfig } | null {
  const sourceIb = sourceNode.activeInbounds.find((ib) => ib.tag === sourceInboundTag);
  const normTag = normalizeInboundTag(sourceInboundTag);

  const allowedRoles: string[] =
    sourceNode.role === "TUNNEL"
      ? ["BRIDGE", "TUNNEL", "OUTBOUND"]
      : sourceNode.role === "BRIDGE"
        ? ["OUTBOUND"]
        : [];

  if (allowedRoles.length === 0) return null;

  for (const candidate of candidateNodes) {
    if (candidate.uuid === sourceNode.uuid || candidate.name === sourceNode.name) continue;
    if (!allowedRoles.includes(candidate.role)) continue;

    for (const ib of candidate.activeInbounds) {
      const candidateNorm = normalizeInboundTag(ib.tag);

      // Rule 1: Normalized tag match (e.g. "in-default-loop" -> "in-default", "vless-ws-tls-lu2-in" -> "vless-ws-tls-in")
      if (normTag === candidateNorm && normTag !== sourceInboundTag.toLowerCase()) {
        return { node: candidate, inbound: ib };
      }

      // Rule 2: Exact base tag match if source had "-loop" suffix
      if (sourceInboundTag.endsWith("-loop") && ib.tag === sourceInboundTag.slice(0, -5)) {
        return { node: candidate, inbound: ib };
      }

      // Rule 3: WebSocket fallback path match
      if (
        sourceIb?.path &&
        ib.path &&
        sourceIb.path === ib.path &&
        sourceInboundTag.includes("loop") &&
        !ib.tag.includes("loop")
      ) {
        return { node: candidate, inbound: ib };
      }

      // Rule 4: Internal loop port match
      if (
        sourceIb?.port &&
        ib.port &&
        sourceIb.port === ib.port &&
        sourceIb.port >= 10000 &&
        sourceInboundTag.includes("loop") &&
        !ib.tag.includes("loop")
      ) {
        return { node: candidate, inbound: ib };
      }
    }
  }

  return null;
}

export function resolveConnectionNodes(
  inbound: string,
  outbound: string,
  processingNodeName: string,
  nodes: RemnaNode[],
  userConnectedNode?: string
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
    if (owner) {
      originNode = owner;
    } else {
      originNode = nodes.find((n) => n.role === "BRIDGE") || nodes[0]!;
    }
  }

  // 2. Determine whether traffic entered via a predecessor TUNNEL node
  let prependHop: HopInfo | null = null;
  if (originNode.role === "BRIDGE") {
    const connectedTunnel = nodes.find(
      (n) =>
        n.role === "TUNNEL" &&
        (n.uuid === userConnectedNode ||
          n.name === userConnectedNode ||
          n.shortName === userConnectedNode)
    );

    const tunnelNode = connectedTunnel || nodes.find((n) => n.role === "TUNNEL");

    if (tunnelNode) {
      const matchingTunnelIb =
        tunnelNode.activeInbounds.find((ib) => ib.tag === `${inbound}-loop`) ||
        tunnelNode.activeInbounds.find(
          (ib) => normalizeInboundTag(ib.tag) === normalizeInboundTag(inbound) && ib.tag.includes("loop")
        ) ||
        tunnelNode.activeInbounds.find((ib) => {
          const originIb = originNode!.activeInbounds.find((o) => o.tag === inbound);
          return originIb?.path && ib.path && originIb.path === ib.path;
        });

      if (matchingTunnelIb && (connectedTunnel || inbound.includes("default") || inbound.includes("in-"))) {
        prependHop = {
          nodeName: tunnelNode.name,
          shortName: tunnelNode.shortName,
          role: "TUNNEL",
          tag: matchingTunnelIb.tag,
          port: matchingTunnelIb.port,
        };
      }
    }
  }

  // 3. Assemble dynamic hop chain
  const hops: HopInfo[] = [];

  if (prependHop) {
    hops.push(prependHop);
  }

  const originIb = originNode.activeInbounds.find((ib) => ib.tag === inbound);
  hops.push({
    nodeName: originNode.name,
    shortName: originNode.shortName,
    role: originNode.role,
    tag: inbound,
    port: originIb?.port,
  });

  // 4. Trace forward if origin was a TUNNEL without prependHop
  if (!prependHop && originNode.role === "TUNNEL") {
    const visitedUuids = new Set<string>([originNode.uuid]);
    let currentSrc = originNode;
    let currentTag = inbound;

    while (true) {
      const nextHop = findDownstreamHop(currentSrc, currentTag, nodes);
      if (!nextHop || visitedUuids.has(nextHop.node.uuid)) {
        break;
      }

      visitedUuids.add(nextHop.node.uuid);
      hops.push({
        nodeName: nextHop.node.name,
        shortName: nextHop.node.shortName,
        role: nextHop.node.role,
        tag: nextHop.inbound.tag,
        port: nextHop.inbound.port,
      });

      currentSrc = nextHop.node;
      currentTag = nextHop.inbound.tag;
      if (currentSrc.role === "BRIDGE" || currentSrc.role === "OUTBOUND") {
        break;
      }
    }
  }

  // 5. Check for OUTBOUND egress nodes (e.g. FI1 for finland-out)
  if (outbound) {
    const outLower = outbound.toLowerCase();
    const egressNode = nodes.find(
      (n) =>
        n.role === "OUTBOUND" &&
        !hops.some((h) => h.shortName === n.shortName) &&
        (outLower.includes(n.shortName.toLowerCase()) ||
          outLower.includes(n.countryCode.toLowerCase()) ||
          outLower.includes(n.name.toLowerCase()))
    );

    if (egressNode) {
      const egressIb = egressNode.activeInbounds[0];
      hops.push({
        nodeName: egressNode.name,
        shortName: egressNode.shortName,
        role: "OUTBOUND",
        tag: egressIb?.tag || "egress",
        port: egressIb?.port,
      });
    }
  }

  // 6. Deduplicate and format output
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
  const hopTags = hops.map((h) => `${h.shortName}: ${h.tag}`);
  const detailedPathway = `${hopTags.join(" → ")} → ${outbound || "direct"}`;

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
