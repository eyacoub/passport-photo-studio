import { test, expect } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";

// Public NASA portraits, sourced from scikit-image v0.24.0 and matplotlib v3.9.2.
const fixture = name => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

test("local AI, download failure/retry, recoloring, and mixed-person A4 exports", async ({ page, context, browserName }) => {
  await page.addInitScript(() => localStorage.setItem("passport_language", "en"));
  const requests = [];
  const errors = [];
  context.on("request", request => requests.push({ url: request.url(), method: request.method() }));
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => localStorage.setItem("passport_removebg_key", "obsolete-test-key"));
  await context.route("https://**", route => route.abort());
  await page.goto("/");
  await expect(page.locator("#btnUpload")).toBeEnabled();
  await expect(page.locator("#removebgKey")).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem("passport_removebg_key"))).toBeNull();

  // A failed model download must leave a retryable photo, not add raw output.
  const modelRoute = "**/ai/**";
  let releaseModel;
  const holdModel = new Promise(resolve => { releaseModel = resolve; });
  await context.route(modelRoute, async route => {
    await holdModel;
    await route.abort();
  });
  await page.locator("#fileInput").setInputFiles(fixture("astronaut.png"));
  try {
    await expect(page.locator("#validationMsg")).toContainText("Loading local AI model", { timeout: 30_000 });
  } finally {
    releaseModel();
  }
  await expect(page.locator("#validationMsg")).toContainText("Background apply failed", { timeout: 60_000 });
  console.log("download failure handled");
  await expect(page.locator("#btnAddPhoto")).toBeDisabled();
  await expect(page.locator("#btnApplyBg")).toBeEnabled();
  await context.unroute(modelRoute);
  await page.locator("#btnApplyBg").click();
  await expect(page.locator("#btnAddPhoto")).toBeEnabled({ timeout: 300_000 });
  expect(await page.evaluate(() => {
    const canvas = document.getElementById("photoCanvas");
    return [...canvas.getContext("2d").getImageData(5, 5, 1, 1).data];
  })).toEqual([255, 255, 255, 255]);
  console.log("local AI success");
  await page.locator("#qty").fill("2");
  await page.locator("#btnAddPhoto").click();
  const firstPhoto = await page.locator(".sheetPerson img").first().getAttribute("src");

  // Recolor the cached transparent foreground with network access blocked.
  await page.locator('input[name="bgColor"][value="D0D0D0"]').check();
  await expect(page.locator("#btnAddPhoto")).toBeEnabled({ timeout: 10_000 });
  const corner = await page.evaluate(() => [...document.getElementById("photoCanvas").getContext("2d").getImageData(5, 5, 1, 1).data]);
  expect(corner.slice(0, 3)).toEqual([208, 208, 208]); // Preserve the selected gray without enhancement.
  await page.locator('input[name="bgColor"][value="FFFFFF"]').check();
  await expect(page.locator("#btnAddPhoto")).toBeEnabled();

  await page.locator("#fileInput").setInputFiles(fixture("grace_hopper.jpg"));
  await expect(page.locator("#btnAddPhoto")).toBeEnabled({ timeout: 90_000 });
  console.log("second portrait success");
  await page.locator("#qty").fill("3");
  await page.locator("#btnAddPhoto").click();
  await expect(page.locator("#sheetMeta")).toContainText("2 people • 5/30 photos");
  expect(await page.locator(".sheetPerson img").first().getAttribute("src")).toBe(firstPhoto);
  expect(await page.locator(".sheetPerson img").nth(1).getAttribute("src")).not.toBe(firstPhoto);
  await page.locator("#qty").fill("30");
  await page.locator("#btnAddPhoto").click();
  await expect(page.locator("#sheetMessage")).toContainText("Not enough room");

  for (const [id, extension] of [["#btnDownloadJpg", "jpg"], ["#btnDownloadPdf", "pdf"]]) {
    const downloadPromise = page.waitForEvent("download");
    await page.locator(id).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(new RegExp(`_x5\\.${extension}$`));
    const bytes = await readFile(await download.path());
    expect(bytes.length).toBeGreaterThan(10_000);
    if (extension === "pdf") expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
    else expect([...bytes.subarray(0, 2)]).toEqual([255, 216]);
  }
  await page.locator("#btnRetake").click();
  await expect(page.locator("#sheetMeta")).toContainText("5/30 photos");
  await expect(page.locator("#btnDownloadPdf")).toBeEnabled();
  await page.locator(".sheetPerson input").first().fill("1");
  await page.locator(".sheetPerson input").first().blur();
  await expect(page.locator("#sheetMeta")).toContainText("5/30 photos");
  await page.locator(".sheetPerson").first().getByRole("button", { name: "Update copies", exact: true }).click();
  await expect(page.locator("#sheetMeta")).toContainText("4/30 photos");
  // Clicking Remove with an uncommitted edit must remove immediately.
  await page.locator(".sheetPerson input").first().fill("10");
  await page.locator(".sheetPerson").first().getByRole("button", { name: "Remove", exact: true }).click();
  await expect(page.locator(".sheetPerson")).toHaveCount(1);
  await expect(page.locator("#sheetMeta")).toContainText("3/30 photos");

  // Playwright's temporary WebKit profile clears Cache Storage on reload.
  if (browserName !== "webkit") {
    await context.route("**/ai/*", route =>
      /\/[a-f0-9]{64}$/.test(new URL(route.request().url()).pathname) ? route.abort() : route.continue());
    await page.reload();
    await expect(page.locator("#btnUpload")).toBeEnabled();
    await page.locator("#fileInput").setInputFiles(fixture("astronaut.png"));
    await expect(page.locator("#btnAddPhoto")).toBeEnabled({ timeout: 60_000 });
  }

  expect(requests.filter(request => request.method !== "GET")).toEqual([]);
  expect(requests.filter(request => request.url.includes("api.remove.bg"))).toEqual([]);
  expect(requests.filter(request => request.url.startsWith("https://"))).toEqual([]);
  expect(errors).toEqual([]);
});


test("camera detects and captures a face without remote downloads", async ({ page, context }) => {
  await page.addInitScript(() => {
    localStorage.setItem("passport_language", "en");
    Object.defineProperty(navigator, "userAgent", { value: "iPhone" });
    Object.defineProperty(navigator, "canShare", { value: ({ files }) => files.length === 1 });
    Object.defineProperty(navigator, "share", { value: async ({ files: [file] }) => {
      if (window.shareError) throw new DOMException("Share failed", window.shareError);
      window.sharedFile = { name: file.name, type: file.type, bytes: [...new Uint8Array(await file.slice(0, 5).arrayBuffer())] };
    } });
  });
  const external = [];
  await context.route("https://**", route => { external.push(route.request().url()); return route.abort(); });
  await page.goto("/");
  await expect(page.locator("#btnUpload")).toBeEnabled();
  const size = page.getByRole("combobox", { name: "Photo size" });
  const photo = page.locator("#photoCanvas");
  await expect(size).toHaveValue("35x45");
  await size.selectOption("40x40");
  await expect(page.locator(".overlay__frame")).toHaveCSS("aspect-ratio", "40 / 40");
  await page.locator("#btnStart").click();
  await expect(page.locator("#btnCapture")).toBeEnabled({ timeout: 30_000 });
  await page.locator("#btnCapture").click();
  await expect(page.locator("#btnAddPhoto")).toBeEnabled({ timeout: 90_000 });
  await expect(page.locator("#processingMessage")).toContainText("Background removed locally");
  await expect(photo).toHaveAttribute("width", "709");
  await expect(photo).toHaveAttribute("height", "709");
  await size.selectOption("35x45");
  await page.locator("#btnAddPhoto").click();
  await expect(page.locator("#sheetMeta")).toContainText("4/30 photos");
  const firstPhoto = await page.locator(".sheetPerson img").first().getAttribute("src");

  await size.selectOption("50x30");
  await expect(page.locator("#btnAddPhoto")).toBeEnabled();
  await expect(photo).toHaveAttribute("width", "886");
  await expect(photo).toHaveAttribute("height", "531");

  await size.selectOption("120x80");
  await expect(page.locator("#qty")).toHaveValue("3");
  await expect(photo).toHaveAttribute("width", "2126");
  await expect(photo).toHaveAttribute("height", "1417");
  await page.locator("#btnAddPhoto").click();
  await expect(page.locator("#sheetMessage")).toContainText("Only 2 spaces remain");
  await page.locator("#qty").fill("2");
  await page.locator("#btnAddPhoto").click();
  await expect(page.locator("#sheetMeta")).toContainText("6 photos");
  await expect(page.locator(".sheetPerson img").first()).toHaveAttribute("src", firstPhoto);
  await expect(page.locator(".sheetPerson input").nth(1)).toHaveAttribute("max", "2");

  // The exported A4 sheet should retain each photo's physical dimensions.
  await page.evaluate(() => {
    const strokeRect = CanvasRenderingContext2D.prototype.strokeRect;
    window.exportedSizes = [];
    CanvasRenderingContext2D.prototype.strokeRect = function (x, y, width, height) {
      if (this.canvas.width === 2480) {
        window.exportedSizes.push([Math.round(width * 210 / this.canvas.width),
          Math.round(height * 297 / this.canvas.height)]);
      }
      return strokeRect.call(this, x, y, width, height);
    };
  });
  const downloadPdf = page.locator("#btnDownloadPdf");
  await downloadPdf.click();
  await expect.poll(() => page.evaluate(() => window.sharedFile)).toEqual({
    name: expect.stringMatching(/_x6\.pdf$/),
    type: "application/pdf",
    bytes: [37, 80, 68, 70, 45],
  });
  expect(await page.evaluate(() => window.exportedSizes)).toEqual([
    [35, 45], [35, 45], [35, 45], [35, 45], [120, 80], [120, 80],
  ]);

  await page.evaluate(() => { window.shareError = "AbortError"; });
  await downloadPdf.click();
  await expect(page.locator("#exportMessage")).toBeEmpty();
  await page.evaluate(() => { window.shareError = "NotAllowedError"; });
  await downloadPdf.click();
  await expect(page.locator("#exportMessage")).toContainText("Tap Download again");
  const download = page.waitForEvent("download");
  await downloadPdf.click();
  expect((await download).suggestedFilename()).toMatch(/_x6\.pdf$/);
  await expect(page).toHaveURL("/");
  await expect(page.locator("#sheetMeta")).toContainText("6 photos");
  await expect(page.locator("#exportMessage")).toBeEmpty();
  expect(external).toEqual([]);
});

test("Arabic switch preserves photos, translates actions, and remembers the language", async ({ page, context }) => {
  await context.route("https://**", route => route.abort());
  await page.goto("/");
  await expect(page.locator("#btnUpload")).toBeEnabled();
  await expect(page.locator("#languageSelect")).toHaveValue("ar");
  await expect(page.locator("#qty")).toHaveValue("4");
  await expect(page.locator("html")).toHaveAttribute("lang", "ar");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page).toHaveTitle("استوديو صور جواز السفر");
  await expect(page.getByRole("button", {name:"اختيار صورة", exact:true})).toBeVisible();
  await context.route("**/ai/**", route => route.abort());
  await page.locator("#fileInput").setInputFiles(fixture("astronaut.png"));
  await expect(page.locator("#processingMessage")).toContainText("تعذّر تطبيق الخلفية", {timeout:30_000});
  await page.locator("#languageSelect").selectOption("en");
  await expect(page.locator("#processingMessage")).toContainText("Background apply failed");
  await page.locator("#languageSelect").selectOption("ar");
  await context.unroute("**/ai/**");
  await page.locator("#btnApplyBg").click();
  await expect(page.locator("#btnAddPhoto")).toBeEnabled({timeout:90_000});
  await expect(page.locator("#processingMessage")).toContainText("تمت إزالة الخلفية على جهازك");
  await page.locator("#qty").fill("2");
  await page.locator("#btnAddPhoto").click();
  await expect(page.locator("#sheetMeta")).toContainText("٢/٣٠");
  const thumbnail = await page.locator(".sheetPerson img").getAttribute("src");
  await expect(page.getByRole("button", {name:"تحديث عدد النسخ", exact:true})).toBeVisible();
  await expect(page.getByRole("button", {name:"إزالة", exact:true})).toBeVisible();
  await page.locator(".sheetPerson input").fill("3");
  await page.locator("#languageSelect").selectOption("en");
  await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
  await expect(page.locator("#sheetMeta")).toContainText("2/30 photos");
  await expect(page.locator(".sheetPerson input")).toHaveValue("3");
  await expect(page.locator(".sheetPerson img")).toHaveAttribute("src", thumbnail);
  await page.getByRole("button", {name:"Update copies", exact:true}).click();
  await expect(page.locator("#sheetMeta")).toContainText("3/30 photos");
  await page.locator("#languageSelect").selectOption("ar");
  await expect(page.locator("#sheetMessage")).toHaveText("تم تحديث عدد النسخ.");
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", {name:"تنزيل ورقة الطباعة (PDF)", exact:true}).click();
  expect((await downloadPromise).suggestedFilename()).toMatch(/_x3\.pdf$/);
  await page.setViewportSize({width:390,height:844});
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({path:testOutput("arabic-mobile.png"),fullPage:true});
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.setViewportSize({width:1280,height:1000});
  await page.screenshot({path:testOutput("arabic-desktop.png"),fullPage:true});
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("lang", "ar");
  await expect(page.locator("#languageSelect")).toHaveValue("ar");
  await expect(page.getByRole("button", {name:"اختيار صورة", exact:true})).toBeVisible();
});

function testOutput(name) { return test.info().outputPath(name); }
