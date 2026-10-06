import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  DRAWER_SWIPE_BAND_MAX_END_PX,
  DRAWER_SWIPE_BAND_MIN_END_PX,
  DRAWER_SWIPE_BAND_START_PX,
  DRAWER_SWIPE_BAND_WIDTH_RATIO,
  blocksDrawerSwipe,
  clampDrawerX,
  drawerGeometry,
  drawerReveal,
  drawerSwipeBandEnd,
  isDrawerSwipeStart,
  resolveDrawerRelease,
} = await jiti.import("./useSidebarSwipe.ts");

// A 280px drawer at the left edge, as the mobile CSS lays it out.
const geometry = drawerGeometry(280, 0);
// The narrowest phone this ships on: 480x854 physical at density 220.
const PHONE = 349;

test("an opening swipe only starts in the edge band", () => {
  assert.equal(isDrawerSwipeStart(0, PHONE), false, "the outer edge belongs to the system back gesture");
  assert.equal(isDrawerSwipeStart(DRAWER_SWIPE_BAND_START_PX - 1, PHONE), false, "still inside the system back gesture inset");
  assert.equal(isDrawerSwipeStart(DRAWER_SWIPE_BAND_START_PX, PHONE), true);
  assert.equal(isDrawerSwipeStart(170, PHONE), true, "half of a 349px phone is inside the band");
  assert.equal(isDrawerSwipeStart(drawerSwipeBandEnd(PHONE), PHONE), true);
  assert.equal(isDrawerSwipeStart(drawerSwipeBandEnd(PHONE) + 1, PHONE), false, "the right half keeps its own gestures");
});

test("the band end follows the viewport, within bounds", () => {
  assert.equal(drawerSwipeBandEnd(PHONE), 174.5, "half of a narrow phone");
  assert.equal(drawerSwipeBandEnd(430), 215, "a wider phone gets a wider band");
  assert.equal(drawerSwipeBandEnd(240), DRAWER_SWIPE_BAND_MIN_END_PX, "a very narrow screen keeps a usable band");
  assert.equal(drawerSwipeBandEnd(1280), DRAWER_SWIPE_BAND_MAX_END_PX, "a wide screen does not hand half its layout to the drawer");
});

test("the band clears the system back gesture inset", () => {
  // config_backGestureInset is 30dp on Android gesture navigation, and CSS
  // pixels are dp in this viewport, so the constant holds at any density.
  assert.ok(DRAWER_SWIPE_BAND_START_PX > 30, "the band must start outside the system inset");
  assert.ok(DRAWER_SWIPE_BAND_WIDTH_RATIO <= 0.5, "the band must leave the right half alone");
});

test("content that pans sideways keeps its own gesture", () => {
  assert.equal(blocksDrawerSwipe({ overflowX: "auto", clientWidth: 300, scrollWidth: 900 }), true);
  assert.equal(blocksDrawerSwipe({ overflowX: "scroll", clientWidth: 300, scrollWidth: 900 }), true);
  assert.equal(blocksDrawerSwipe({ overflowX: "auto", clientWidth: 300, scrollWidth: 300 }), false, "nothing overflows, so nothing pans");
  assert.equal(blocksDrawerSwipe({ overflowX: "hidden", clientWidth: 300, scrollWidth: 900 }), false);
  assert.equal(blocksDrawerSwipe({ overflowX: "visible", clientWidth: 300, scrollWidth: 900 }), false);
});

test("the drawer stays between closed and open", () => {
  assert.equal(geometry.closedX, -280);
  assert.equal(clampDrawerX(-400, geometry), -280, "a drag past closed stops at closed");
  assert.equal(clampDrawerX(120, geometry), 0, "a drag past open stops at open");
  assert.equal(clampDrawerX(-140, geometry), -140);
});

test("the left inset moves the closed position, not the open one", () => {
  const notched = drawerGeometry(280, 44);
  assert.equal(notched.closedX, -324);
  assert.equal(notched.openX, 0);
});

test("reveal runs from 0 closed to 1 open", () => {
  assert.equal(drawerReveal(-280, geometry), 0);
  assert.equal(drawerReveal(-140, geometry), 0.5);
  assert.equal(drawerReveal(0, geometry), 1);
});

test("a short slow drag springs back and a long one opens", () => {
  assert.equal(resolveDrawerRelease({
    x: -200, dx: 80, elapsedMs: 400, geometry,
  }), false, "80px of 280px is not enough");
  assert.equal(resolveDrawerRelease({
    x: -100, dx: 180, elapsedMs: 400, geometry,
  }), true);
});

test("a flick decides by direction, not by distance", () => {
  assert.equal(resolveDrawerRelease({
    x: -250, dx: 30, elapsedMs: 40, geometry,
  }), true, "a fast right flick opens even barely moved");
  assert.equal(resolveDrawerRelease({
    x: -40, dx: -30, elapsedMs: 40, geometry,
  }), false, "a fast left flick closes a mostly open drawer");
});

test("a flick needs movement and time to be a flick", () => {
  assert.equal(resolveDrawerRelease({
    x: -260, dx: 15, elapsedMs: 40, geometry,
  }), false, "15px is a tap with drift, not a flick");
  assert.equal(resolveDrawerRelease({
    x: -260, dx: 30, elapsedMs: 0, geometry,
  }), false, "no elapsed time cannot be a flick");
});
