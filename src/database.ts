import { DatabaseSync } from "node:sqlite";
import { mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const DATA_DIR = process.env.DATA_DIR || (existsSync("/app/data") ? "/app/data" : join(process.cwd(), "data"));
mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = join(DATA_DIR, "xray_monitor.db");
export const db = new DatabaseSync(DB_PATH);

// Setup Pragmas for high concurrency, durability and low memory usage
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA cache_size = -8000;
  PRAGMA temp_store = MEMORY;
  PRAGMA busy_timeout = 20000;
`);

export function initDatabase() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      user_id INTEGER PRIMARY KEY,
      username TEXT NOT NULL,
      status TEXT DEFAULT 'ACTIVE',
      last_seen TEXT
    );

    CREATE TABLE IF NOT EXISTS connections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      user_id INTEGER NOT NULL,
      proto TEXT NOT NULL,
      dest TEXT NOT NULL,
      root_domain TEXT NOT NULL,
      category TEXT NOT NULL,
      port INTEGER NOT NULL,
      inbound TEXT NOT NULL,
      outbound TEXT NOT NULL,
      node TEXT NOT NULL DEFAULT 'local'
    );

    CREATE TABLE IF NOT EXISTS hourly_stats (
      hour_bucket TEXT NOT NULL,
      user_id INTEGER NOT NULL,
      root_domain TEXT NOT NULL,
      category TEXT NOT NULL,
      inbound TEXT NOT NULL,
      node TEXT NOT NULL DEFAULT 'local',
      hits INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (hour_bucket, user_id, root_domain, inbound, node)
    );

    CREATE TABLE IF NOT EXISTS inbound_hourly_traffic (
      hour_bucket TEXT NOT NULL,
      node TEXT NOT NULL DEFAULT '',
      inbound TEXT NOT NULL,
      uplink_bytes INTEGER NOT NULL DEFAULT 0,
      downlink_bytes INTEGER NOT NULL DEFAULT 0,
      total_bytes INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (hour_bucket, node, inbound)
    );

    CREATE INDEX IF NOT EXISTS idx_conn_ts ON connections(ts DESC);
    CREATE INDEX IF NOT EXISTS idx_conn_user ON connections(user_id, ts DESC);
    CREATE INDEX IF NOT EXISTS idx_conn_domain ON connections(root_domain, ts DESC);
    CREATE INDEX IF NOT EXISTS idx_conn_node ON connections(node, ts DESC);
    CREATE INDEX IF NOT EXISTS idx_stats_hour ON hourly_stats(hour_bucket DESC);
    CREATE INDEX IF NOT EXISTS idx_stats_user ON hourly_stats(user_id, hour_bucket DESC);
    CREATE INDEX IF NOT EXISTS idx_stats_domain ON hourly_stats(root_domain, hour_bucket DESC);
    CREATE INDEX IF NOT EXISTS idx_stats_node ON hourly_stats(node, hour_bucket DESC);

    -- Clean excluded internal accounts
    DELETE FROM connections WHERE user_id IN (SELECT user_id FROM users WHERE username = 'tunnel' OR username LIKE '%tunnel%');
    DELETE FROM hourly_stats WHERE user_id IN (SELECT user_id FROM users WHERE username = 'tunnel' OR username LIKE '%tunnel%');
    DELETE FROM users WHERE username = 'tunnel' OR username LIKE '%tunnel%';
  `);
}

// Ensure tables exist before preparing statements
initDatabase();

export interface ConnectionRecord {
  ts: string;
  user_id: number;
  proto: string;
  dest: string;
  root_domain: string;
  category: string;
  port: number;
  inbound: string;
  outbound: string;
  node: string;
}

export interface UserSyncRecord {
  id: number;
  username: string;
  status: string;
  connected_node?: string;
}

// Prepared Statements
const insertConnStmt = db.prepare(`
  INSERT INTO connections (ts, user_id, proto, dest, root_domain, category, port, inbound, outbound, node)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
`);

const upsertHourlyStmt = db.prepare(`
  INSERT INTO hourly_stats (hour_bucket, user_id, root_domain, category, inbound, node, hits)
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(hour_bucket, user_id, root_domain, inbound, node) DO UPDATE SET
    hits = hourly_stats.hits + excluded.hits;
`);

const updateUserLastSeenStmt = db.prepare(`
  INSERT INTO users (user_id, username, status, last_seen)
  VALUES (?, ?, 'ACTIVE', ?)
  ON CONFLICT(user_id) DO UPDATE SET
    last_seen = excluded.last_seen;
`);

const syncUserStmt = db.prepare(`
  INSERT INTO users (user_id, username, status, connected_node)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(user_id) DO UPDATE SET
    username = excluded.username,
    status = excluded.status,
    connected_node = excluded.connected_node;
`);

const upsertInboundTrafficStmt = db.prepare(`
  INSERT INTO inbound_hourly_traffic (hour_bucket, node, inbound, uplink_bytes, downlink_bytes, total_bytes)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(hour_bucket, node, inbound) DO UPDATE SET
    uplink_bytes = inbound_hourly_traffic.uplink_bytes + excluded.uplink_bytes,
    downlink_bytes = inbound_hourly_traffic.downlink_bytes + excluded.downlink_bytes,
    total_bytes = inbound_hourly_traffic.total_bytes + excluded.total_bytes;
`);

export function recordInboundTrafficDelta(
  hour_bucket: string,
  node: string,
  inbound: string,
  uplinkDelta: number,
  downlinkDelta: number
) {
  if (uplinkDelta <= 0 && downlinkDelta <= 0) return;
  const totalDelta = uplinkDelta + downlinkDelta;
  upsertInboundTrafficStmt.run(hour_bucket, node || "", inbound, uplinkDelta, downlinkDelta, totalDelta);
}

export function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return (bytes / Math.pow(k, i)).toFixed(2) + " " + sizes[i];
}

export function insertBatch(records: ConnectionRecord[]) {
  if (records.length === 0) return;

  const hourlyMap = new Map<string, {
    hour_bucket: string;
    user_id: number;
    root_domain: string;
    category: string;
    inbound: string;
    node: string;
    hits: number;
  }>();

  const userLastSeen = new Map<number, string>();

  for (const r of records) {
    const hour_bucket = r.ts.slice(0, 13) + ":00:00";
    const key = `${hour_bucket}|${r.user_id}|${r.root_domain}|${r.category}|${r.inbound}|${r.node}`;
    const existing = hourlyMap.get(key);
    if (existing) {
      existing.hits += 1;
    } else {
      hourlyMap.set(key, {
        hour_bucket,
        user_id: r.user_id,
        root_domain: r.root_domain,
        category: r.category,
        inbound: r.inbound,
        node: r.node,
        hits: 1,
      });
    }
    userLastSeen.set(r.user_id, r.ts);
  }

  db.exec("BEGIN TRANSACTION;");
  try {
    for (const r of records) {
      insertConnStmt.run(
        r.ts,
        r.user_id,
        r.proto,
        r.dest,
        r.root_domain,
        r.category,
        r.port,
        r.inbound,
        r.outbound,
        r.node
      );
    }

    for (const h of hourlyMap.values()) {
      upsertHourlyStmt.run(
        h.hour_bucket,
        h.user_id,
        h.root_domain,
        h.category,
        h.inbound,
        h.node,
        h.hits
      );
    }

    for (const [uid, ts] of userLastSeen.entries()) {
      updateUserLastSeenStmt.run(uid, `User_${uid}`, ts);
    }
    db.exec("COMMIT;");
  } catch (err) {
    db.exec("ROLLBACK;");
    throw err;
  }
}

export function purgeExcludedUsers(userIds: number[]) {
  if (userIds.length === 0) return;
  const placeholders = userIds.map(() => "?").join(",");
  db.exec("BEGIN TRANSACTION;");
  try {
    db.prepare(`DELETE FROM connections WHERE user_id IN (${placeholders});`).run(...userIds);
    db.prepare(`DELETE FROM hourly_stats WHERE user_id IN (${placeholders});`).run(...userIds);
    db.prepare(`DELETE FROM users WHERE user_id IN (${placeholders}) OR username = 'tunnel';`).run(...userIds);
    db.exec("COMMIT;");
  } catch (err) {
    db.exec("ROLLBACK;");
    throw err;
  }
}

export function syncUsers(users: UserSyncRecord[]) {
  if (users.length === 0) return;
  const validUsers = users.filter((u) => u.username !== "tunnel" && !u.username.toLowerCase().includes("tunnel"));
  db.exec("BEGIN TRANSACTION;");
  try {
    for (const u of validUsers) {
      syncUserStmt.run(u.id, u.username, u.status, u.connected_node || "");
    }
    db.exec("COMMIT;");
  } catch (err) {
    db.exec("ROLLBACK;");
    throw err;
  }
}

export function cleanupOldData(rawHours: number = 48, rollupDays: number = 60) {
  const rawCutoff = new Date(Date.now() - rawHours * 3600 * 1000).toISOString().replace("T", " ").slice(0, 19);
  const rollupCutoff = new Date(Date.now() - rollupDays * 86400 * 1000).toISOString().replace("T", " ").slice(0, 19);

  db.prepare("DELETE FROM connections WHERE ts < ?;").run(rawCutoff);
  db.prepare("DELETE FROM hourly_stats WHERE hour_bucket < ?;").run(rollupCutoff);
}

function getTimeFilter(hours: number): string {
  if (hours <= 0) return "1970-01-01 00:00:00";
  return new Date(Date.now() - hours * 3600 * 1000).toISOString().replace("T", " ").slice(0, 19);
}

// Query Helpers
export function querySummary(hours: number = 24, userId?: number, inbound?: string, node?: string) {
  const cutoff = getTimeFilter(hours);
  const conditions = ["hour_bucket >= ?"];
  const params: (string | number)[] = [cutoff];

  if (userId) {
    conditions.push("user_id = ?");
    params.push(userId);
  }
  if (inbound) {
    conditions.push("inbound = ?");
    params.push(inbound);
  }
  if (node) {
    conditions.push("node = ?");
    params.push(node);
  }

  const whereSql = conditions.join(" AND ");

  const agg = db.prepare(`
    SELECT 
      COALESCE(SUM(hits), 0) as total_requests,
      COUNT(DISTINCT user_id) as active_users,
      COUNT(DISTINCT root_domain) as unique_domains
    FROM hourly_stats
    WHERE ${whereSql};
  `).get(...params) as { total_requests: number; active_users: number; unique_domains: number } | undefined;

  const topDomain = db.prepare(`
    SELECT root_domain, SUM(hits) as hits
    FROM hourly_stats
    WHERE ${whereSql}
    GROUP BY root_domain
    ORDER BY hits DESC LIMIT 1;
  `).get(...params) as { root_domain: string; hits: number } | undefined;

  const topInbound = db.prepare(`
    SELECT inbound, SUM(hits) as hits
    FROM hourly_stats
    WHERE ${whereSql}
    GROUP BY inbound
    ORDER BY hits DESC LIMIT 1;
  `).get(...params) as { inbound: string; hits: number } | undefined;

  const trafficConditions = ["hour_bucket >= ?"];
  const trafficParams: (string | number)[] = [cutoff];
  if (node) {
    trafficConditions.push("node = ?");
    trafficParams.push(node);
  }

  const trafficAgg = db.prepare(`
    SELECT 
      COALESCE(SUM(uplink_bytes), 0) as total_uplink,
      COALESCE(SUM(downlink_bytes), 0) as total_downlink,
      COALESCE(SUM(total_bytes), 0) as total_bytes
    FROM inbound_hourly_traffic
    WHERE ${trafficConditions.join(" AND ")};
  `).get(...trafficParams) as { total_uplink: number; total_downlink: number; total_bytes: number } | undefined;

  return {
    total_requests: agg?.total_requests || 0,
    active_users: agg?.active_users || 0,
    unique_domains: agg?.unique_domains || 0,
    top_domain: topDomain?.root_domain || "None",
    top_domain_hits: topDomain?.hits || 0,
    top_inbound: topInbound?.inbound || "None",
    top_inbound_hits: topInbound?.hits || 0,
    total_traffic_bytes: trafficAgg?.total_bytes || 0,
    total_traffic_formatted: formatBytes(trafficAgg?.total_bytes || 0),
    total_uplink_formatted: formatBytes(trafficAgg?.total_uplink || 0),
    total_downlink_formatted: formatBytes(trafficAgg?.total_downlink || 0),
  };
}

export function queryTopDomains(hours: number = 24, limit: number = 20, userId?: number, inbound?: string, search?: string, node?: string) {
  const cutoff = getTimeFilter(hours);
  const conditions = ["hour_bucket >= ?"];
  const params: (string | number)[] = [cutoff];

  if (userId) {
    conditions.push("user_id = ?");
    params.push(userId);
  }
  if (inbound) {
    conditions.push("inbound = ?");
    params.push(inbound);
  }
  if (node) {
    conditions.push("node = ?");
    params.push(node);
  }
  if (search) {
    conditions.push("root_domain LIKE ?");
    params.push(`%${search}%`);
  }

  const whereSql = conditions.join(" AND ");
  params.push(limit);

  return db.prepare(`
    SELECT 
      root_domain,
      category,
      SUM(hits) as total_hits,
      COUNT(DISTINCT user_id) as users_count
    FROM hourly_stats
    WHERE ${whereSql}
    GROUP BY root_domain, category
    ORDER BY total_hits DESC
    LIMIT ?;
  `).all(...params);
}

export function queryTopInbounds(hours: number = 24, userId?: number, node?: string) {
  const cutoff = getTimeFilter(hours);
  const conditions = ["h.hour_bucket >= ?"];
  const params: (string | number)[] = [cutoff, cutoff];

  if (userId) {
    conditions.push("h.user_id = ?");
    params.push(userId);
  }
  if (node) {
    conditions.push("h.node = ?");
    params.push(node);
  }

  const whereSql = conditions.join(" AND ");

  const rows = db.prepare(`
    SELECT 
      h.inbound,
      SUM(h.hits) as total_hits,
      SUM(CASE WHEN u.connected_node LIKE '%IR%' THEN h.hits ELSE 0 END) as tunneled_hits,
      SUM(CASE WHEN u.connected_node NOT LIKE '%IR%' OR u.connected_node IS NULL THEN h.hits ELSE 0 END) as direct_hits,
      COUNT(DISTINCT h.user_id) as users_count,
      COUNT(DISTINCT CASE WHEN u.connected_node LIKE '%IR%' THEN h.user_id ELSE NULL END) as tunneled_users,
      COUNT(DISTINCT CASE WHEN u.connected_node NOT LIKE '%IR%' OR u.connected_node IS NULL THEN h.user_id ELSE NULL END) as direct_users,
      COALESCE(t.uplink_bytes, 0) as uplink_bytes,
      COALESCE(t.downlink_bytes, 0) as downlink_bytes,
      COALESCE(t.total_bytes, 0) as total_bytes
    FROM hourly_stats h
    LEFT JOIN users u ON h.user_id = u.user_id
    LEFT JOIN (
      SELECT 
        inbound,
        SUM(uplink_bytes) as uplink_bytes,
        SUM(downlink_bytes) as downlink_bytes,
        SUM(total_bytes) as total_bytes
      FROM inbound_hourly_traffic
      WHERE hour_bucket >= ?
      GROUP BY inbound
    ) t ON h.inbound = t.inbound
    WHERE ${whereSql}
    GROUP BY h.inbound
    ORDER BY total_hits DESC;
  `).all(...params) as {
    inbound: string;
    total_hits: number;
    tunneled_hits: number;
    direct_hits: number;
    users_count: number;
    tunneled_users: number;
    direct_users: number;
    uplink_bytes: number;
    downlink_bytes: number;
    total_bytes: number;
  }[];

  return rows.map((r) => ({
    ...r,
    uplink_formatted: formatBytes(r.uplink_bytes),
    downlink_formatted: formatBytes(r.downlink_bytes),
    total_formatted: formatBytes(r.total_bytes),
  }));
}

export function queryTimeline(hours: number = 24, userId?: number, inbound?: string, node?: string) {
  const cutoff = getTimeFilter(hours);
  const conditions = ["hour_bucket >= ?"];
  const params: (string | number)[] = [cutoff];

  if (userId) {
    conditions.push("user_id = ?");
    params.push(userId);
  }
  if (inbound) {
    conditions.push("inbound = ?");
    params.push(inbound);
  }
  if (node) {
    conditions.push("node = ?");
    params.push(node);
  }

  const whereSql = conditions.join(" AND ");

  return db.prepare(`
    SELECT 
      hour_bucket,
      SUM(hits) as hits
    FROM hourly_stats
    WHERE ${whereSql}
    GROUP BY hour_bucket
    ORDER BY hour_bucket ASC;
  `).all(...params);
}

export function queryUsers(hours: number = 24, search?: string) {
  const cutoff = getTimeFilter(hours);
  const params: (string | number)[] = [cutoff];
  let searchSql = "";

  if (search) {
    searchSql = "WHERE (u.username LIKE ? OR CAST(u.user_id AS TEXT) LIKE ?)";
    params.push(`%${search}%`, `%${search}%`);
  }

  return db.prepare(`
    SELECT 
      u.user_id,
      u.username,
      u.status,
      COALESCE(u.connected_node, '') as connected_node,
      u.last_seen,
      COALESCE(s.total_hits, 0) as total_hits,
      COALESCE(s.unique_domains, 0) as unique_domains
    FROM users u
    LEFT JOIN (
      SELECT 
        user_id,
        SUM(hits) as total_hits,
        COUNT(DISTINCT root_domain) as unique_domains
      FROM hourly_stats
      WHERE hour_bucket >= ?
      GROUP BY user_id
    ) s ON u.user_id = s.user_id
    ${searchSql}
    ORDER BY total_hits DESC, u.last_seen DESC;
  `).all(...params);
}

export function queryUserDetail(userId: number, hours: number = 24) {
  const cutoff = getTimeFilter(hours);

  const user = db.prepare("SELECT * FROM users WHERE user_id = ?;").get(userId) || {
    user_id: userId,
    username: `User_${userId}`,
    status: "UNKNOWN",
  };

  const topDomains = db.prepare(`
    SELECT root_domain, category, SUM(hits) as hits
    FROM hourly_stats
    WHERE user_id = ? AND hour_bucket >= ?
    GROUP BY root_domain, category
    ORDER BY hits DESC LIMIT 15;
  `).all(userId, cutoff);

  const inbounds = db.prepare(`
    SELECT inbound, SUM(hits) as hits
    FROM hourly_stats
    WHERE user_id = ? AND hour_bucket >= ?
    GROUP BY inbound
    ORDER BY hits DESC;
  `).all(userId, cutoff);

  const recent = db.prepare(`
    SELECT ts, proto, dest, root_domain, port, inbound, outbound, node
    FROM connections
    WHERE user_id = ?
    ORDER BY id DESC LIMIT 20;
  `).all(userId);

  return {
    user,
    top_domains: topDomains,
    inbounds,
    recent_connections: recent,
  };
}

export function queryDomainDetail(domain: string, hours: number = 24) {
  const cutoff = getTimeFilter(hours);

  const topUsers = db.prepare(`
    SELECT 
      h.user_id,
      COALESCE(u.username, 'User_' || h.user_id) as username,
      SUM(h.hits) as hits,
      MAX(h.hour_bucket) as last_seen
    FROM hourly_stats h
    LEFT JOIN users u ON h.user_id = u.user_id
    WHERE h.root_domain = ? AND h.hour_bucket >= ?
    GROUP BY h.user_id, u.username
    ORDER BY hits DESC LIMIT 20;
  `).all(domain, cutoff);

  const timeline = db.prepare(`
    SELECT hour_bucket, SUM(hits) as hits
    FROM hourly_stats
    WHERE root_domain = ? AND hour_bucket >= ?
    GROUP BY hour_bucket
    ORDER BY hour_bucket ASC;
  `).all(domain, cutoff);

  const recent = db.prepare(`
    SELECT c.ts, c.proto, c.dest, c.port, c.inbound, c.outbound, c.user_id, COALESCE(u.username, 'User_' || c.user_id) as username
    FROM connections c
    LEFT JOIN users u ON c.user_id = u.user_id
    WHERE c.root_domain = ?
    ORDER BY c.id DESC LIMIT 20;
  `).all(domain);

  return {
    domain,
    top_users: topUsers,
    timeline,
    recent_connections: recent,
  };
}

export function queryLiveStream(limit: number = 50, userId?: number, search?: string, node?: string) {
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (userId) {
    conditions.push("c.user_id = ?");
    params.push(userId);
  }
  if (node) {
    conditions.push("c.node = ?");
    params.push(node);
  }
  if (search) {
    conditions.push("(c.dest LIKE ? OR c.root_domain LIKE ?)");
    params.push(`%${search}%`, `%${search}%`);
  }

  const whereSql = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  params.push(limit);

  return db.prepare(`
    SELECT 
      c.id, c.ts, c.user_id, COALESCE(u.username, 'User_' || c.user_id) as username,
      COALESCE(u.connected_node, '') as connected_node,
      c.proto, c.dest, c.root_domain, c.category, c.port, c.inbound, c.outbound, c.node
    FROM connections c
    LEFT JOIN users u ON c.user_id = u.user_id
    ${whereSql}
    ORDER BY c.id DESC
    LIMIT ?;
  `).all(...params);
}
