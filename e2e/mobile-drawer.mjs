import assert from "node:assert/strict";
import { join } from "node:path";

/**
 * The mobile drawer swipe (hooks/useSidebarSwipe.ts). It needs touch events, so
 * this check opens its own touch-capable mobile context instead of reusing the
 * shared one, and closes it again before returning.
 */
export async function checkMobileDrawer({ browser, base, artifacts }) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
    locale: "en-US",
  });
  try {
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (event) => { if (event.type() === "error") errors.push(event.text()); });
    const cdp = await context.newCDPSession(page);
    const sidebarX = async () => Math.round((await page.locator("#session-sidebar").boundingBox()).x);
    const backdropOpacity = () => page.locator(".sidebar-overlay-backdrop")
      .evaluate((el) => getComputedStyle(el).opacity);

    // Touch moves have to arrive as separate frames: the hook commits to the
    // horizontal axis on the first move that passes its threshold.
    const touch = (type, x, y) => cdp.send("Input.dispatchTouchEvent", {
      type,
      touchPoints: type === "touchEnd" ? [] : [{ x, y }],
    });
    async function drag({ fromX, toX, y = 400, steps = 12, holdMs = 0, driftY = 0 }) {
      await touch("touchStart", fromX, y);
      for (let i = 1; i <= steps; i++) {
        const progress = i / steps;
        await touch("touchMove", fromX + (toX - fromX) * progress, y + driftY * progress);
        await page.waitForTimeout(8);
      }
      if (holdMs) await page.waitForTimeout(holdMs);
      await touch("touchEnd");
    }

    await page.goto(base, { waitUntil: "domcontentloaded" });
    await page.locator("#session-sidebar").waitFor();
    await page.waitForTimeout(600);
    // Only errors the gesture itself produces are this check's business.
    errors.length = 0;

    assert.equal(await sidebarX(), -280, "the drawer starts closed");
    assert.equal(await backdropOpacity(), "0", "the backdrop starts hidden");

    // A right drag from inside the edge band follows the finger.
    await touch("touchStart", 40, 400);
    for (const x of [50, 80, 120, 160, 190]) {
      await touch("touchMove", x, 400);
      await page.waitForTimeout(10);
    }
    const followed = await sidebarX();
    assert.ok(followed > -160 && followed < -80, `the drawer follows the finger, got x=${followed}`);
    assert.ok(Number(await backdropOpacity()) > 0.1, "the backdrop fades in with the drag");
    await touch("touchEnd");
    await page.waitForTimeout(500);
    assert.equal(await sidebarX(), 0, "releasing past the threshold opens the drawer");
    assert.equal(await backdropOpacity(), "1", "the backdrop is fully visible when open");

    // A left drag on the open drawer closes it.
    await drag({ fromX: 200, toX: 10 });
    await page.waitForTimeout(500);
    assert.equal(await sidebarX(), -280, "dragging the drawer left closes it");

    // A short slow drag springs back.
    await drag({ fromX: 30, toX: 70, steps: 8, holdMs: 400 });
    await page.waitForTimeout(500);
    assert.equal(await sidebarX(), -280, "a short slow drag springs back");

    // The band reaches half the viewport, so the left half opens the drawer.
    await drag({ fromX: 150, toX: 300 });
    await page.waitForTimeout(500);
    assert.equal(await sidebarX(), 0, "a swipe from the middle of the left half opens the drawer");
    await drag({ fromX: 200, toX: 10 });
    await page.waitForTimeout(500);
    assert.equal(await sidebarX(), -280, "and dragging it back closes it again");

    // Only the band starts a gesture: the right half and the system back-gesture
    // inset (Android's config_backGestureInset, 30dp) keep theirs.
    await drag({ fromX: 260, toX: 380 });
    await page.waitForTimeout(500);
    assert.equal(await sidebarX(), -280, "a swipe over the right half does not open the drawer");
    await drag({ fromX: 20, toX: 200 });
    await page.waitForTimeout(500);
    assert.equal(await sidebarX(), -280, "a swipe inside the system back gesture inset does not open the drawer");

    // Content that pans sideways keeps that gesture even inside the band. The
    // probes go inside the shell element, because that is where the gesture
    // listens: a probe in document.body would never reach it and every
    // assertion below would pass for the wrong reason. Each guard case is
    // followed by the same drag with the probe gone, so a pass cannot come from
    // a drag that would not have opened the drawer anyway.
    const dragInBand = { fromX: 80, toX: 190, y: 240 };
    async function expectClosed(args, message) {
      await drag(args);
      await page.waitForTimeout(500);
      assert.equal(await sidebarX(), -280, message);
    }
    async function expectControl(args, message) {
      await drag(args);
      await page.waitForTimeout(500);
      assert.equal(await sidebarX(), 0, message);
      // Pulled almost fully off screen: a slow drag is decided by how much of the
      // drawer it reveals (35%), so a shorter one would depend on drag timing.
      await drag({ fromX: 200, toX: 10, y: args.y });
      await page.waitForTimeout(500);
      assert.equal(await sidebarX(), -280, "and closes again");
    }

    await page.evaluate(() => {
      const probe = document.createElement("div");
      probe.id = "pan-probe";
      probe.style.cssText = "position:fixed;left:40px;top:200px;width:120px;height:80px;overflow-x:auto;z-index:300;background:#333";
      probe.innerHTML = '<div style="width:600px;height:100%"></div>';
      document.querySelector("#session-sidebar").parentElement.appendChild(probe);
      // Scrolled right, so dragging right pans it back and the move is visible.
      probe.scrollLeft = 200;
    });
    await expectClosed(dragInBand, "a sideways pan inside the band does not open the drawer");
    const panned = await page.locator("#pan-probe").evaluate((el) => el.scrollLeft);
    assert.ok(panned < 200, `the panning element keeps the gesture, scrollLeft=${panned}`);
    await page.evaluate(() => document.getElementById("pan-probe")?.remove());
    await expectControl(dragInBand, "the same drag opens the drawer once the panning element is gone");

    // A caret drag in a field keeps its own gesture.
    await page.evaluate(() => {
      const field = document.createElement("textarea");
      field.id = "caret-probe";
      field.style.cssText = "position:fixed;left:40px;top:200px;width:120px;height:80px;z-index:300";
      field.value = "text to drag a caret through";
      document.querySelector("#session-sidebar").parentElement.appendChild(field);
    });
    await expectClosed(dragInBand, "a drag in a text field does not open the drawer");
    await page.evaluate(() => document.getElementById("caret-probe")?.remove());
    await expectControl(dragInBand, "the same drag opens the drawer once the field is gone");

    // An active selection owns the drag (its handles are dragged, not the drawer).
    await page.evaluate(() => {
      const target = document.createElement("p");
      target.id = "selection-probe";
      target.textContent = "selectable text inside the band";
      target.style.cssText = "position:fixed;left:40px;top:200px;width:120px;height:80px;z-index:300;background:#333;color:#eee";
      document.querySelector("#session-sidebar").parentElement.appendChild(target);
      const range = document.createRange();
      range.selectNodeContents(target);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    });
    await expectClosed(dragInBand, "a drag while text is selected does not open the drawer");
    await page.evaluate(() => {
      getSelection()?.removeAllRanges();
      document.getElementById("selection-probe")?.remove();
    });
    await expectControl(dragInBand, "the same drag opens the drawer once the selection is cleared");

    // A touch held past the long-press threshold is selecting, not dragging.
    await touch("touchStart", 60, 400);
    await page.waitForTimeout(650);
    for (const x of [80, 120, 160]) {
      await touch("touchMove", x, 400);
      await page.waitForTimeout(10);
    }
    await touch("touchEnd");
    await page.waitForTimeout(500);
    assert.equal(await sidebarX(), -280, "a long press before moving does not open the drawer");
    await expectControl({ fromX: 60, toX: 180, y: 400 }, "the same drag without the hold opens the drawer");

    // A vertical drag from the band is a scroll.
    await drag({ fromX: 40, toX: 44, y: 500, steps: 6, driftY: 180 });
    await page.waitForTimeout(500);
    assert.equal(await sidebarX(), -280, "a vertical drag from the band scrolls instead of opening");

    // The existing ways to open and close still work.
    await drag({ fromX: 40, toX: 260 });
    await page.waitForTimeout(500);
    assert.equal(await sidebarX(), 0, "the drawer reopened for the backdrop check");
    await page.locator(".sidebar-overlay-backdrop").click({ position: { x: 300, y: 400 } });
    await page.waitForTimeout(500);
    assert.equal(await sidebarX(), -280, "the backdrop still closes the drawer");
    await page.getByRole("button", { name: "Show sidebar", exact: true }).first().click();
    await page.waitForTimeout(500);
    assert.equal(await sidebarX(), 0, "the toolbar toggle still opens the drawer");

    assert.deepEqual(errors, [], "no browser errors during the drawer swipe");
    await page.screenshot({ path: join(artifacts, "mobile-drawer-open.png") });
  } finally {
    await context.close();
  }
}
