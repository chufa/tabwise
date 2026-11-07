import { backupHash, canonicalJSON } from "./backup.js";

const ROOT = "tabwiseMetadata";
const PREFIX = "tabwiseSync:";
const bytes = (value) => new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value)).length;
export const syncFingerprint = (value) => canonicalJSON(value ?? null);
export function packSyncMetadata(metadata, generation = crypto.randomUUID()) {
  // Measure JSON-escaped bytes, including Unicode and key overhead.
  const chunks = [], text = JSON.stringify(metadata);
  let chunk = "", length = 0;
  for (const char of text) {
    const cost = bytes(JSON.stringify(char)) - 2;
    if (length + cost > 6000) { chunks.push(chunk); chunk = ""; length = 0; }
    chunk += char; length += cost;
  }
  if (chunk) chunks.push(chunk);
  const values = Object.fromEntries(chunks.map((value, index) => [`${PREFIX}${generation}:${index}`, value]));
  const manifest = { format: "chunks-v1", generation, count: chunks.length, size: bytes(text), checksum: "0".repeat(64) };
  const totalBytes = Object.entries({ ...values, [ROOT]: manifest }).reduce((sum, [key, value]) => sum + bytes(key) + bytes(JSON.stringify(value)), 0);
  if (totalBytes > 45000) throw new Error("所选同步内容超过 45 KB，请减少工作区或页面数量；完整内容可通过备份转移。");
  return { values, manifest, totalBytes };
}
export async function readSyncMetadata(area = chrome.storage.sync) {
  const all = await area.get(null), root = all[ROOT];
  if (!root) return { metadata: null, token: syncFingerprint(null) };
  if (root.format !== "chunks-v1") return { metadata: root, token: syncFingerprint(root) };
  if (!Number.isInteger(root.count) || root.count < 1 || root.count > 20 || !/^[\w-]{1,80}$/.test(root.generation)) throw new Error("同步清单无效，请稍后重新预览。");
  const chunks = Array.from({ length: root.count }, (_, index) => all[`${PREFIX}${root.generation}:${index}`]);
  if (chunks.some((chunk) => typeof chunk !== "string") || bytes(chunks.join("")) !== root.size) throw new Error("同步分块尚未完整到达，请稍后重新预览。");
  const metadata = JSON.parse(chunks.join(""));
  if (root.checksum !== await backupHash(metadata)) throw new Error("同步分块校验失败，请稍后重新预览。");
  return { metadata, token: syncFingerprint(root) };
}
export async function writeSyncMetadata(metadata, expectedToken, area = chrome.storage.sync) {
  const packed = packSyncMetadata(metadata);
  packed.manifest.checksum = await backupHash(metadata);
  const all = await area.get(null);
  if (syncFingerprint(all[ROOT]) !== expectedToken) throw new Error("同步版本已变化，请重新预览。");
  const active = all[ROOT]?.format === "chunks-v1" ? `${PREFIX}${all[ROOT].generation}:` : null;
  const orphanKeys = Object.keys(all).filter((key) => key.startsWith(PREFIX) && !key.startsWith(active || "\0"));
  if (orphanKeys.length) await area.remove(orphanKeys);
  const used = area.getBytesInUse ? await area.getBytesInUse(null) : bytes(all);
  if (used + packed.totalBytes > (area.QUOTA_BYTES || 102400)) throw new Error("同步空间不足，请减少所选内容后再试。");
  // Old generation stays readable until every new chunk has committed.
  await area.set(packed.values);
  const latest = await area.get(ROOT);
  if (syncFingerprint(latest[ROOT]) !== expectedToken) throw new Error("同步版本已变化，新分块未启用，请重新预览。");
  await area.set({ [ROOT]: packed.manifest });
  const obsolete = Object.keys(all).filter((key) => key.startsWith(PREFIX) && !key.startsWith(`${PREFIX}${packed.manifest.generation}:`));
  if (obsolete.length) await area.remove(obsolete).catch(() => {});
  return packed;
}
