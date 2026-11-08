// A fragment identifies a view within the same extension document.
// Queries and different origins/paths still fail the exact document check.
export function isExtensionPage(sender, path) {
  return sender?.id === chrome.runtime.id && typeof sender.url === "string"
    && sender.url.split("#")[0] === chrome.runtime.getURL(path);
}

export async function resolvePopupSender(sender) {
  if (sender?.documentId || !isExtensionPage(sender, "src/popup/popup.html")) return sender;
  // Actual action popups can omit MessageSender.documentId even though Chrome
  // exposes the document through getContexts. Keep preview ownership tied to
  // that browser-issued document, and refuse ambiguous concurrent popups.
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["POPUP"], documentUrls: [sender.url]
  });
  const matches = contexts.filter((context) => context.contextType === "POPUP"
    && context.documentUrl === sender.url && typeof context.documentId === "string" && context.documentId);
  if (matches.length !== 1) throw new Error("无法确认当前弹窗，请关闭后重新打开，或使用工作台。");
  return { ...sender, documentId: matches[0].documentId };
}
