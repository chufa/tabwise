import { backupFingerprint, backupHash, createBackup, createEncryptedBackup, readBackup } from "../shared/backup.js";
import { getAllWorkspaces, getSettings, getWorkspaces, queueStorage, validateWorkspaceCapacity } from "../shared/storage.js";
import { appendBackupEvent, backupStatus } from "../shared/backup-status.js";

export function createBackupManager(sanitizeSettings) {
  const previews = new Map();
  const exports = new Map();
  async function record(event) {
    return queueStorage("local", async () => {
      const { backupManagement = {} } = await chrome.storage.local.get("backupManagement");
      await chrome.storage.local.set({ backupManagement: appendBackupEvent(backupManagement, event) });
    });
  }
  const contentState = (workspaces) => backupHash(workspaces);
  async function describe(decoded, existing) {
    const fingerprints = new Set(await Promise.all(existing.filter((item) => !item.deletedAt).map(backupFingerprint)));
    return Promise.all(decoded.workspaces.map(async (workspace, index) => {
      const fingerprint = await backupFingerprint(workspace);
      const duplicate = fingerprints.has(fingerprint);
      fingerprints.add(fingerprint);
      return { index, name: workspace.name, pages: workspace.tabs.length, windows: workspace.windowCount || 1,
        versions: workspace.versions.length, duplicate, conflict: existing.some((item) => item.id === workspace.id || item.name === workspace.name),
        empty: !workspace.tabs.length };
    }));
  }
  async function commit(decoded, options, expected) {
    return queueStorage("local", async () => {
      const existing = await getAllWorkspaces();
      if (expected && await contentState(existing) !== expected) throw new Error("本地工作区已变化，请重新预览备份。");
      const indices = options.indices ?? decoded.workspaces.map((_, index) => index);
      if (!Array.isArray(indices) || indices.some((index) => !Number.isInteger(index) || !decoded.workspaces[index])) throw new Error("导入选择无效，请重新预览。");
      const fingerprints = new Set(await Promise.all(existing.filter((item) => !item.deletedAt).map(backupFingerprint)));
      const additions = [];
      let skipped = 0;
      for (const index of new Set(indices)) {
        const workspace = decoded.workspaces[index];
        const fingerprint = await backupFingerprint(workspace);
        if (!workspace.tabs.length || (!options.keepCopies && fingerprints.has(fingerprint))) { skipped++; continue; }
        fingerprints.add(fingerprint);
        additions.push({ ...workspace, id: crypto.randomUUID(), provenance: { sourceId: workspace.provenance?.sourceId || workspace.id, importedAt: Date.now() } });
      }
      const workspaces = [...additions, ...existing];
      validateWorkspaceCapacity(workspaces);
      const values = { workspaces };
      if (options.includeSettings) values.settings = sanitizeSettings(await getSettings(), decoded.settings);
      await chrome.storage.local.set(values);
      return { ok: true, count: additions.length, skipped };
    });
  }
  return {
    async export(options = {}, sender = {}) {
      const backup = await queueStorage("local", async () => options.password
        ? createEncryptedBackup({ settings: await getSettings(), workspaces: await getWorkspaces(), password: options.password })
        : createBackup({ settings: await getSettings(), workspaces: await getWorkspaces() }));
      const exportRequestId = crypto.randomUUID();
      for (const [id, item] of exports) if (item.expiresAt <= Date.now() || item.owner === sender.documentId) exports.delete(id);
      if (exports.size >= 5) exports.delete(exports.keys().next().value);
      exports.set(exportRequestId, { owner: sender.documentId, expiresAt: Date.now() + 300000,
        counts: backup.integrity.counts, encrypted: Boolean(options.password) });
      return { ...backup, exportRequestId };
    },
    async downloadRequested(id, sender) {
      const item = exports.get(id);
      if (!item || !sender.documentId || item.owner !== sender.documentId || item.expiresAt <= Date.now()) throw new Error("导出记录已过期，请重新导出。");
      await record({ kind: "download-requested", ok: true, verified: true, counts: item.counts, encrypted: item.encrypted });
      exports.delete(id);
      return { ok: true };
    },
    async status() {
      const [{ backupManagement = {} }, settings] = await Promise.all([chrome.storage.local.get("backupManagement"), getSettings()]);
      return backupStatus(backupManagement, settings.backupReminderDays);
    },
    async drill(backup, password) {
      try {
        const decoded = await readBackup(backup, password);
        const result = { kind: "drill", ok: true, verified: decoded.verified, encrypted: Boolean(decoded.encrypted), counts: decoded.counts };
        await record(result);
        return { ...result, warnings: decoded.warnings };
      } catch (error) {
        await record({ kind: "drill", ok: false });
        throw error;
      }
    },
    async prepare(backup, sender, password) {
      if (!sender.documentId) throw new Error("请从设置页预览备份。");
      const decoded = await readBackup(backup, password), existing = await getAllWorkspaces();
      const id = crypto.randomUUID();
      for (const [key, preview] of previews) if (preview.expiresAt <= Date.now() || preview.owner === sender.documentId) previews.delete(key);
      if (previews.size >= 5) previews.delete(previews.keys().next().value);
      previews.set(id, { decoded, owner: sender.documentId, expiresAt: Date.now() + 5 * 60_000, signature: await contentState(existing) });
      return { ok: true, previewId: id, verified: decoded.verified, encrypted: Boolean(decoded.encrypted), warnings: decoded.warnings, counts: decoded.counts, workspaces: await describe(decoded, existing) };
    },
    async confirm(message, sender) {
      const preview = previews.get(message.previewId);
      if (!preview || preview.owner !== sender.documentId || preview.expiresAt <= Date.now()) throw new Error("导入预览已过期，请重新选择备份。");
      const result = await commit(preview.decoded, message, preview.signature);
      previews.delete(message.previewId);
      return result;
    },
    async import(backup, password) { return commit(await readBackup(backup, password), { includeSettings: true }); }
  };
}
