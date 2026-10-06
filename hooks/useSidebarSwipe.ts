"use client";

import { useEffect, type RefObject } from "react";
import { flushSync } from "react-dom";

/**
 * A right swipe that opens the mobile drawer starts inside this band, measured
 * from the left edge of the viewport. The band deliberately begins inside the
 * edge: Android's back gesture owns the outer strip of the screen
 * (`config_backGestureInset`, 30dp on the Jelly Star) and a page cannot exclude
 * it, so a swipe that starts there leaves the app instead of opening the drawer.
 * CSS pixels are dp here (the viewport is device-width at scale 1), so the same
 * constant clears the inset at any display density.
 */
export const DRAWER_SWIPE_BAND_START_PX = 36;
/**
 * The far end follows the viewport instead of a fixed pixel count: a phone is
 * narrow, and a constant band would cover a different share of each screen. Half
 * the width keeps the gesture easy to start while the right half keeps its own.
 */
export const DRAWER_SWIPE_BAND_WIDTH_RATIO = 0.5;
export const DRAWER_SWIPE_BAND_MIN_END_PX = 140;
export const DRAWER_SWIPE_BAND_MAX_END_PX = 260;
/** Movement that commits a swipe to one axis; below it a scroll can still win. */
const AXIS_COMMIT_PX = 10;
/** A touch held this long is a long press (text selection), not a drawer drag. */
const LONG_PRESS_MS = 500;
/** How much of the drawer a slow drag has to reveal to stay open on release. */
const OPEN_REVEAL_RATIO = 0.35;
/** A flick at least this fast (px/ms) decides by direction alone. */
const FLING_VELOCITY_PX_PER_MS = 0.4;
const FLING_MIN_PX = 20;

export interface DrawerGeometry {
  /** translateX of the fully closed drawer (negative). */
  closedX: number;
  /** translateX of the fully open drawer. */
  openX: number;
}

export function drawerSwipeBandEnd(viewportWidth: number): number {
  return Math.min(
    DRAWER_SWIPE_BAND_MAX_END_PX,
    Math.max(DRAWER_SWIPE_BAND_MIN_END_PX, viewportWidth * DRAWER_SWIPE_BAND_WIDTH_RATIO),
  );
}

export function isDrawerSwipeStart(clientX: number, viewportWidth: number): boolean {
  return clientX >= DRAWER_SWIPE_BAND_START_PX && clientX <= drawerSwipeBandEnd(viewportWidth);
}

/** The style facts that decide whether an element pans horizontally. */
export interface ScrollBox {
  overflowX: string;
  clientWidth: number;
  scrollWidth: number;
}

/**
 * A wide band reaches over content that scrolls sideways (code blocks, wide
 * tables). A touch that starts in such an element is panning it, not opening
 * the drawer, so that gesture stays with the content.
 */
export function blocksDrawerSwipe(box: ScrollBox): boolean {
  return (box.overflowX === "auto" || box.overflowX === "scroll")
    && box.scrollWidth > box.clientWidth;
}

/**
 * The drawer's two resting positions. It is a fixed element at
 * `left: env(safe-area-inset-left)`, so closed it sits one width plus that
 * inset to the left of the open position.
 */
export function drawerGeometry(width: number, leftInset: number): DrawerGeometry {
  return { closedX: -(width + leftInset), openX: 0 };
}

export function clampDrawerX(x: number, geometry: DrawerGeometry): number {
  return Math.min(geometry.openX, Math.max(geometry.closedX, x));
}

/** How much of the drawer is on screen: 0 closed, 1 fully open. */
export function drawerReveal(x: number, geometry: DrawerGeometry): number {
  const travel = geometry.openX - geometry.closedX;
  if (!(travel > 0)) return 1;
  return Math.min(1, Math.max(0, (x - geometry.closedX) / travel));
}

/**
 * Whether a released drag leaves the drawer open. A flick decides by direction;
 * a slower drag has to have revealed enough of the drawer.
 */
export function resolveDrawerRelease(options: {
  x: number;
  dx: number;
  elapsedMs: number;
  geometry: DrawerGeometry;
}): boolean {
  const { x, dx, elapsedMs, geometry } = options;
  const flicked = Math.abs(dx) >= FLING_MIN_PX
    && elapsedMs > 0
    && Math.abs(dx) / elapsedMs >= FLING_VELOCITY_PX_PER_MS;
  if (flicked) return dx > 0;
  return drawerReveal(x, geometry) >= OPEN_REVEAL_RATIO;
}

export interface SidebarSwipeOptions {
  /** Mobile drawer mode only; the desktop sidebar stays in the split layout. */
  enabled: boolean;
  /** Whether the drawer is currently open. */
  open: boolean;
  /**
   * Touches inside this element may start the gesture. Overlays rendered as
   * siblings (Settings, dialogs) are outside it and never start one.
   */
  containerRef: RefObject<HTMLElement | null>;
  sidebarRef: RefObject<HTMLElement | null>;
  backdropRef: RefObject<HTMLElement | null>;
  onOpen: () => void;
  onClose: () => void;
}

/**
 * Drags the mobile sidebar drawer: a right swipe from the left edge opens it, a
 * left swipe on the open drawer closes it. The drawer follows the finger; on
 * release the state is committed and the inline styles are dropped, so the CSS
 * transition finishes the move from wherever the finger left the drawer.
 */
export function useSidebarSwipe(options: SidebarSwipeOptions): void {
  const { enabled, open, containerRef, sidebarRef, backdropRef, onOpen, onClose } = options;

  useEffect(() => {
    const container = containerRef.current;
    const drawer = sidebarRef.current;
    if (!enabled || !container || !drawer) return;
    // The handlers below are hoisted, so they read the element through a
    // non-null alias instead of the guard's narrowing.
    const sidebar: HTMLElement = drawer;

    let startX = 0;
    let startY = 0;
    let startedAt = 0;
    let baseX = 0;
    let drawerX = 0;
    let fingerDx = 0;
    let geometry: DrawerGeometry = { closedX: 0, openX: 0 };
    let dragging = false;

    // Hands the drawer back to its CSS state. The class then animates from the
    // dragged position, because that is still the last rendered style.
    const dropInlineStyles = () => {
      sidebar.style.transform = "";
      sidebar.style.transition = "";
      const backdrop = backdropRef.current;
      if (!backdrop) return;
      backdrop.style.opacity = "";
      backdrop.style.transition = "";
    };

    const stopTracking = () => {
      window.removeEventListener("touchmove", onTouchMove);
      window.removeEventListener("touchend", onTouchEnd);
      window.removeEventListener("touchcancel", onTouchCancel);
    };

    const release = (next: boolean) => {
      // The class has to be committed before the inline styles go away: the
      // transition can only animate to the released position once React
      // rendered it, and a frame in between would show the old one.
      if (next !== open) {
        flushSync(() => {
          if (next) onOpen();
          else onClose();
        });
      }
      dropInlineStyles();
    };

    // Content that owns the gesture keeps it: a sideways pan, a caret drag in a
    // field, or a drag of a selection handle.
    const contentKeepsGesture = (target: EventTarget | null): boolean => {
      if (!(target instanceof Element)) return false;
      if (target.closest("input, textarea, select, [contenteditable='true']")) return true;
      const selection = window.getSelection();
      if (selection && !selection.isCollapsed) return true;
      for (let node: Element | null = target; node && node !== container; node = node.parentElement) {
        const style = window.getComputedStyle(node);
        if (blocksDrawerSwipe({
          overflowX: style.overflowX,
          clientWidth: node.clientWidth,
          scrollWidth: node.scrollWidth,
        })) return true;
      }
      return false;
    };

    function onTouchStart(event: TouchEvent) {
      if (event.touches.length > 1) {
        // A second finger is a pinch or a scroll, not a drawer drag.
        if (dragging) {
          dragging = false;
          dropInlineStyles();
        }
        stopTracking();
        return;
      }
      const touch = event.touches[0];
      // An open drawer is dragged closed from anywhere on it; a closed one only
      // opens from the left band, so the right half keeps its own gestures.
      if (!open && !isDrawerSwipeStart(touch.clientX, window.innerWidth)) return;
      if (contentKeepsGesture(event.target)) return;
      startX = touch.clientX;
      startY = touch.clientY;
      startedAt = Date.now();
      fingerDx = 0;
      dragging = false;
      window.addEventListener("touchmove", onTouchMove, { passive: false });
      window.addEventListener("touchend", onTouchEnd);
      window.addEventListener("touchcancel", onTouchCancel);
    }

    function onTouchMove(event: TouchEvent) {
      const touch = event.touches[0];
      if (!touch) return;
      const dx = touch.clientX - startX;
      const dy = touch.clientY - startY;
      if (!dragging) {
        // A held touch is selecting text; let the selection have the drag.
        if (Date.now() - startedAt > LONG_PRESS_MS) {
          stopTracking();
          return;
        }
        if (Math.abs(dx) < AXIS_COMMIT_PX && Math.abs(dy) < AXIS_COMMIT_PX) return;
        // A mostly vertical move is a scroll (or a long press), not a drag.
        if (Math.abs(dy) >= Math.abs(dx)) {
          stopTracking();
          return;
        }
        dragging = true;
        const rect = sidebar.getBoundingClientRect();
        const leftInset = Number.parseFloat(window.getComputedStyle(sidebar).left) || 0;
        geometry = drawerGeometry(rect.width, leftInset);
        baseX = open ? geometry.openX : geometry.closedX;
        drawerX = baseX;
        sidebar.style.transition = "none";
        const backdrop = backdropRef.current;
        if (backdrop) backdrop.style.transition = "none";
      }
      fingerDx = dx;
      drawerX = clampDrawerX(baseX + dx, geometry);
      sidebar.style.transform = `translateX(${drawerX}px)`;
      const backdrop = backdropRef.current;
      if (backdrop) backdrop.style.opacity = String(drawerReveal(drawerX, geometry));
      // The gesture owns the finger now, so the list behind it must not scroll.
      event.preventDefault();
    }

    function onTouchEnd() {
      stopTracking();
      if (!dragging) return;
      dragging = false;
      release(resolveDrawerRelease({
        x: drawerX,
        dx: fingerDx,
        elapsedMs: Date.now() - startedAt,
        geometry,
      }));
    }

    function onTouchCancel() {
      stopTracking();
      if (!dragging) return;
      dragging = false;
      // The system took the gesture (or the page lost it): keep the state.
      dropInlineStyles();
    }

    container.addEventListener("touchstart", onTouchStart, { passive: true });
    return () => {
      container.removeEventListener("touchstart", onTouchStart);
      stopTracking();
      if (dragging) {
        dragging = false;
        dropInlineStyles();
      }
    };
  }, [backdropRef, containerRef, enabled, onClose, onOpen, open, sidebarRef]);
}
