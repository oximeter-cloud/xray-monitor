import { networkInterfaces } from "node:os";

export interface InboundConfig {
  tag: string;
  port?: number;
  type?: string;
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
      if (tags.includes("tunnel") || tags.includes("iran") || rawName.toLowerCase().includes("iran") || rawName.toLowerCase().includes("ir1")) {
        role = "TUNNEL";
      } else if (tags.includes("bridge") || tags.includes("core") || rawName.toLowerCase().includes("de1") || rawName.toLowerCase().includes("germany")) {
        role = "BRIDGE";
      } else if (tags.includes("outbound") || tags.includes("exit") || rawName.toLowerCase().includes("fi1") || rawName.toLowerCase().includes("finland")) {
        role = "OUTBOUND";
      } else {
        role = "OUTBOUND";
      }

      const rule = (
        n.notes ||
        (role === "TUNNEL"
          ? "Ingress entrance proxy. Forwarding tunnel entry into bridge nodes."
          : role === "BRIDGE"
            ? "Core central gateway & bridge. Full DPI, destination domain analysis, DNS sniffing, and user connection matrix."
            : "Outbound exit node. Handles final egress internet routing.")
      );

      const activeInbounds: InboundConfig[] = (n.configProfile?.activeInbounds || []).map((ib: any) => ({
        tag: ib.tag,
        port: ib.port ? parseInt(ib.port, 10) : undefined,
        type: ib.type || "unknown",
      }));

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

export function resolveConnectionNodes(
  inbound: string,
  outbound: string,
  processingNodeName: string,
  nodes: RemnaNode[],
  userConnectedNode?: string
) {
  const involved: Array<{ role: string; name: string; shortName: string }> = [];

  const bridgeNode =
    nodes.find((n) => n.role === "BRIDGE") ||
    nodes.find((n) => n.name.toLowerCase().includes("de") || n.name.toLowerCase().includes("bridge")) || {
      uuid: "",
      id: 0,
      name: "Bridge-Core",
      shortName: "BRIDGE",
      role: "BRIDGE",
      address: "",
      tags: [],
      rule: "",
      countryCode: "EU",
      activeInbounds: [],
    };

  // Determine actual connection source (from reporting node or user record)
  const isTunnelReport = processingNodeName.toLowerCase().includes("ir") || processingNodeName.toLowerCase().includes("tunnel");
  let isDirect = !isTunnelReport;
  let ingressShortName = bridgeNode.shortName;

  const tunnelNode = nodes.find((n) => n.role === "TUNNEL") || {
    uuid: "",
    id: 0,
    name: "Tunnel-Ingress",
    shortName: "TUNNEL",
    role: "TUNNEL",
    address: "",
    tags: [],
    rule: "",
    countryCode: "IR",
    activeInbounds: [],
  };

  if (userConnectedNode) {
    const matched = nodes.find(
      (n) =>
        n.name === userConnectedNode ||
        n.shortName === userConnectedNode ||
        n.uuid === userConnectedNode
    );
    if (matched && matched.role === "TUNNEL") {
      isDirect = false;
    }
  }

  if (!isDirect) {
    ingressShortName = tunnelNode.shortName;
    involved.push({ role: "TUNNEL", name: tunnelNode.name, shortName: tunnelNode.shortName });
  }

  // Bridge node
  involved.push({ role: "BRIDGE", name: bridgeNode.name, shortName: bridgeNode.shortName });

  // Outbound node (e.g. FI1 for finland-out, etc.)
  const matchingOutbounds = nodes.filter(
    (n) =>
      n.role === "OUTBOUND" &&
      (inbound.toLowerCase().includes(n.shortName.toLowerCase()) ||
        (outbound && outbound.toLowerCase().includes(n.shortName.toLowerCase())) ||
        (outbound && outbound.toLowerCase().includes(n.countryCode.toLowerCase())))
  );

  for (const out of matchingOutbounds) {
    involved.push({ role: "OUTBOUND", name: out.name, shortName: out.shortName });
  }

  return {
    involved,
    isDirect,
    ingressShortName,
  };
}
