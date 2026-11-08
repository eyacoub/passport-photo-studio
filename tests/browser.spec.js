import { test, expect } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";

// Public NASA portraits, sourced from scikit-image v0.24.0 and matplotlib v3.9.2.
const fixture = name => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

test("local AI, download failure/retry, recoloring, and mixed-person A4 exports", async ({ page, context }) => {
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
  await context.route(modelRoute, route => route.abort());
  await page.locator("#fileInput").setInputFiles(fixture("astronaut.png"));
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
  expect(requests.filter(request => request.method !== "GET")).toEqual([]);
  expect(requests.filter(request => request.url.includes("api.remove.bg"))).toEqual([]);
  expect(requests.filter(request => request.url.startsWith("https://"))).toEqual([]);
  expect(errors).toEqual([]);
});


test("camera detects and captures a face without remote downloads", async ({ page, context }) => {
  const external = [];
  await context.route("https://**", route => { external.push(route.request().url()); return route.abort(); });
  await page.goto("/");
  await expect(page.locator("#btnUpload")).toBeEnabled();
  await page.locator("#btnStart").click();
  await expect(page.locator("#btnCapture")).toBeEnabled({ timeout: 30_000 });
  await page.locator("#btnCapture").click();
  await expect(page.locator("#btnAddPhoto")).toBeEnabled({ timeout: 90_000 });
  await expect(page.locator("#processingMessage")).toContainText("Background removed locally");
  await page.locator("#btnAddPhoto").click();
  await expect(page.locator("#sheetMeta")).toContainText("1/30 photos");
  expect(external).toEqual([]);
});

test("Arabic switch preserves photos, translates actions, and remembers the language", async ({ page, context }) => {
  await context.route("https://**", route => route.abort());
  await page.goto("/");
  await expect(page.locator("#btnUpload")).toBeEnabled();
  await page.locator("#languageSelect").selectOption("ar");
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
