import { sanitizeSavedSnapshot, snapshotSignature } from "./session.js";

export const BACKUP_LIMITS = Object.freeze({ bytes: 8 * 1024 * 1024, pagesPerSnapshot: 5000, totalPages: 50000, workspaces: 20, versions: 5 });
const text = (value, limit = 80) => String(value || "").trim().slice(0, limit);
const time = (value) => Number.isFinite(value) && value >= 0 ? value : 0;
export function canonicalJSON(value) {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJSON(item ?? null)).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().filter((key) => value[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${canonicalJSON(value[key])}`).join(",")}}`;
  return JSON.stringify(value ?? null);
}
export async function backupHash(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJSON(value)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
function normalizeWorkspace(source, warnings, depth = 0) {
  if (!source || typeof source !== "object") throw new Error("工作区格式无效。");
  const snapshot = sanitizeSavedSnapshot(source);
  const omitted = (source.tabs?.length || 0) - snapshot.tabs.length;
  if (omitted) warnings.push(`「${text(source.name) || "工作区"}」已过滤 ${omitted} 个非网页或隐私页面。`);
  if ((source.versions?.length || 0) > BACKUP_LIMITS.versions) warnings.push(`「${text(source.name)}」历史版本仅保留最近 5 个。`);
  const normalized = {
    ...snapshot, id: text(source.id, 120), name: text(source.name) || "导入的工作区",
    createdAt: time(source.createdAt), updatedAt: time(source.updatedAt),
    pinned: Boolean(source.pinned), archived: Boolean(source.archived), archivedAt: time(source.archivedAt),
    lastOpenedAt: time(source.lastOpenedAt),
    versions: (Array.isArray(source.versions) ? source.versions : []).slice(0, 5).map((version) => ({
      ...sanitizeSavedSnapshot(version), id: text(version.id, 120), createdAt: time(version.createdAt)
    }))
  };
  if (source.provenance) normalized.provenance = { sourceId: text(source.provenance.sourceId, 120), importedAt: time(source.provenance.importedAt) };
  if (!depth && Array.isArray(source.mergeSources)) {
    if (source.mergeSources.length > 20) throw new Error("合并来源超过 20 个上限。");
    normalized.mergeSources = source.mergeSources.map((item) => normalizeWorkspace(item, warnings, 1));
  }
  return normalized;
}
function counts(workspaces) {
  const result = { workspaces: workspaces.length, pages: 0, windows: 0, groups: 0, versions: 0, historyPages: 0, sourcePages: 0 };
  for (const workspace of workspaces) {
    result.pages += workspace.tabs.length;
    result.windows += workspace.windowCount || (workspace.tabs.length ? 1 : 0);
    result.groups += workspace.groups?.length || 0;
    result.versions += workspace.versions?.length || 0;
    result.historyPages += (workspace.versions || []).reduce((sum, version) => sum + version.tabs.length, 0);
    result.sourcePages += (workspace.mergeSources || []).reduce((sum, source) => sum + source.tabs.length
      + (source.versions || []).reduce((total, version) => total + version.tabs.length, 0), 0);
  }
  if (result.pages + result.historyPages + result.sourcePages > BACKUP_LIMITS.totalPages) throw new Error("备份页面总数超过 50000 页上限，请拆分备份。");
  return result;
}
export async function backupFingerprint(workspace) {
  const clean = normalizeWorkspace(workspace, []);
  return backupHash({ name: clean.name, pinned: clean.pinned, archived: clean.archived,
    snapshot: snapshotSignature(clean), versions: clean.versions.map(snapshotSignature),
    sources: (clean.mergeSources || []).map((source) => ({ name: source.name, snapshot: snapshotSignature(source), versions: source.versions.map(snapshotSignature) })) });
}
export async function createBackup({ settings = {}, workspaces = [] }) {
  const warnings = [];
  const payload = { settings, workspaces: workspaces.map((workspace) => normalizeWorkspace(workspace, warnings)) };
  const backup = { schemaVersion: 2, exportedAt: Date.now(), payload,
    integrity: { algorithm: "SHA-256", checksum: await backupHash(payload), counts: counts(payload.workspaces) }, warnings };
  await readBackup(backup);
  return backup;
}
function encodeBytes(bytes) {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text);
}
function decodeBytes(value) {
  try { return Uint8Array.from(atob(value), (character) => character.charCodeAt(0)); }
  catch { throw new Error("加密备份编码无效。"); }
}
async function encryptionKey(password, salt, iterations) {
  if (typeof password !== "string" || password.length < 12) throw new Error("备份密码至少需要 12 个字符。");
  const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, material, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
export async function createEncryptedBackup({ settings = {}, workspaces = [], password, iterations = 310_000 }) {
  if (!Number.isInteger(iterations) || iterations < 10_000 || iterations > 1_000_000) throw new Error("加密参数无效。");
  const plain = await createBackup({ settings, workspaces });
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await encryptionKey(password, salt, iterations);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(JSON.stringify(plain))));
  return { schemaVersion: 3, exportedAt: Date.now(), encryption: { algorithm: "AES-GCM", kdf: "PBKDF2-SHA-256", iterations, salt: encodeBytes(salt), iv: encodeBytes(iv) },
    ciphertext: encodeBytes(ciphertext), integrity: { algorithm: "SHA-256", checksum: await backupHash(encodeBytes(ciphertext)), counts: plain.integrity.counts } };
}
async function decryptBackup(backup, password) {
  if (!password) throw new Error("此备份已加密，请输入备份密码。");
  const encryption = backup.encryption || {};
  if (encryption.algorithm !== "AES-GCM" || encryption.kdf !== "PBKDF2-SHA-256" || !Number.isInteger(encryption.iterations)) throw new Error("加密备份格式不受支持。");
  if (await backupHash(backup.ciphertext) !== backup.integrity?.checksum) throw new Error("备份完整性校验失败，内容可能被修改。");
  try {
    const key = await encryptionKey(password, decodeBytes(encryption.salt), encryption.iterations);
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: decodeBytes(encryption.iv) }, key, decodeBytes(backup.ciphertext));
    return JSON.parse(new TextDecoder().decode(plain));
  } catch (error) {
    if (error.message?.includes("密码至少")) throw error;
    throw new Error("备份密码错误或内容已损坏。");
  }
}
export async function readBackup(backup, password) {
  if (!backup || ![1, 2, 3].includes(backup.schemaVersion)) throw new Error("备份文件格式不受支持。");
  if (new TextEncoder().encode(JSON.stringify(backup)).byteLength > BACKUP_LIMITS.bytes) throw new Error("备份大小超过 8 MiB 上限。");
  if (backup.schemaVersion === 3) {
    const decoded = await readBackup(await decryptBackup(backup, password));
    return { ...decoded, encrypted: true };
  }
  const payload = backup.schemaVersion === 2 ? backup.payload : backup;
  if (!Array.isArray(payload?.workspaces)) throw new Error("备份工作区格式无效。");
  if (payload.workspaces.length > 20) throw new Error("备份包含超过 20 个工作区，请先整理。");
  if (backup.schemaVersion === 2 && (backup.integrity?.algorithm !== "SHA-256" || await backupHash(payload) !== backup.integrity.checksum)) throw new Error("备份完整性校验失败，内容可能被修改。");
  const warnings = backup.schemaVersion === 1 ? ["旧版备份没有校验码，请核对导入内容。"] : [];
  const workspaces = payload.workspaces.map((workspace) => normalizeWorkspace(workspace, warnings));
  const summary = counts(workspaces);
  if (backup.schemaVersion === 2 && canonicalJSON(summary) !== canonicalJSON(backup.integrity.counts)) throw new Error("备份数量校验失败。");
  return { workspaces, settings: payload.settings && typeof payload.settings === "object" && !Array.isArray(payload.settings) ? payload.settings : {},
    verified: backup.schemaVersion === 2, warnings, counts: summary };
}
