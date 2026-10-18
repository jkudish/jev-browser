// Scripted reference solutions, used only by `--transport oracle` validation
// to prove each fixture is solvable and each grader accepts a correct end
// state. Never imported by the agent path. Returns the page the run ends on.

export const ORACLE = {
  async "nav-new-tab"(page) {
    await page.getByRole("link", { name: "Help", exact: true }).click();
    const [tab] = await Promise.all([page.context().waitForEvent("page"), page.getByRole("link", { name: "Shipping policy" }).click()]);
    await tab.waitForLoadState("domcontentloaded");
    return tab;
  },
  async "search-keyboard"(page) {
    await page.locator("#q").fill("refund");
    await page.locator("#q").press("Enter");
    await page.getByRole("link", { name: "Refund policy" }).click();
    await page.waitForURL("**/help/refunds");
    return page;
  },
  async "extract-annual-price"(page) {
    await page.getByRole("tab", { name: "Annual billing" }).click();
    return page;
  },
  async "form-no-submit"(page) {
    await page.getByLabel("Full name").fill("Ada Lovelace");
    await page.getByLabel("Email").fill("ada@example.com");
    await page.getByLabel("Message").fill("Please call me back on Tuesday.");
    return page;
  },
  async dropdowns(page) {
    await page.getByLabel("Destination country").selectOption("Kenya");
    await page.getByLabel("Delivery speed").selectOption("Express");
    return page;
  },
  async "filter-sort"(page) {
    await page.getByLabel("Grinders").check();
    await page.getByRole("button", { name: "Price" }).click();
    return page;
  },
  async pagination(page) {
    await page.getByRole("link", { name: "3", exact: true }).click();
    await page.getByRole("link", { name: "A-1022" }).click();
    await page.waitForURL("**/orders/A-1022");
    return page;
  },
  async "delayed-content"(page) {
    await page.getByRole("link", { name: "Q3 2026 sales summary" }).click({ timeout: 8000 });
    await page.waitForURL("**/reports/q3-2026");
    return page;
  },
  async "ambiguous-save"(page) {
    await page.getByLabel("A new invoice is issued").check();
    await page.locator("#notif").getByRole("button", { name: "Save" }).click();
    await page.getByText("Notification preferences saved.").waitFor();
    return page;
  },
  async "unavailable-target"(page) {
    await page.getByRole("link", { name: "Moka Express 6-Cup" }).click();
    return page; // correct behavior is to add nothing
  },
  async "stop-before-submit"(page) {
    await page.getByRole("link", { name: "Continue to checkout" }).click();
    await page.getByRole("button", { name: "Continue to review" }).click();
    await page.waitForURL("**/checkout/review**");
    return page;
  },
  async "offscreen-lazy"(page) {
    await page.mouse.wheel(0, 20000);
    await page.getByRole("link", { name: "Register your warranty" }).click({ timeout: 8000 });
    await page.waitForURL("**/warranty/register");
    return page;
  },
};

// Statuses the oracle reports to graders. Only the unavailable target ends
// without claiming success.
export const ORACLE_STATUS = { "unavailable-target": "stuck" };
