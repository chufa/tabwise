// Follow navigation and disclosure controls exactly as a user would.
// No DOM visibility changes: this helper reads the target's ancestors, then clicks controls.
export async function show(page, target) {
  const locator = typeof target === "string" ? page.locator(target) : target;
  await locator.first().waitFor({ state: "attached" });
  const views = await locator.first().evaluate((element) => {
    const result = [];
    for (let node = element; node; node = node.parentElement) {
      if (node.dataset.view) result.unshift({ group: node.closest("[data-navigation]").dataset.navigation, id: node.dataset.view });
    }
    return result;
  });
  for (const { group, id } of views) {
    const button = page.locator(`[data-navigation="${group}"] [data-view-button="${id}"]`);
    if (await button.getAttribute("aria-selected") !== "true") await button.click();
  }
  const details = await locator.first().evaluate((element) => {
    const result = [], all = [...document.querySelectorAll("details")];
    for (let node = element.parentElement; node; node = node.parentElement) {
      if (node.tagName === "DETAILS" && !node.open) result.unshift(all.indexOf(node));
    }
    return result;
  });
  for (const index of details) await page.locator("details").nth(index).locator(":scope > summary").click();
  return locator;
}
