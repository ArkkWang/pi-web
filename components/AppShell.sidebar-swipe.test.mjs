import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");

test("wires the drawer swipe to the mobile drawer only", () => {
  assert.match(source, /useSidebarSwipe\(\{[\s\S]*?enabled: isMobile && !rightPanelOpen/,
    "the file panel covers the phone screen, so the gesture stays off while it is open");
  assert.match(source, /containerRef: shellRef,[\s\S]*?sidebarRef: sidebarResizer\.panelRef,[\s\S]*?backdropRef: sidebarBackdropRef,[\s\S]*?onOpen: openSidebar,[\s\S]*?onClose: closeSidebar,/);
});

test("opening the drawer clears the mobile top panel, closing does not", () => {
  // The toolbar that sets a top panel sits behind the open drawer's backdrop,
  // so closing has nothing to clear (the toggle used to clear both ways).
  assert.match(source, /const openSidebar = useCallback\(\(\) => \{[\s\S]*?setActiveTopPanel\(null\);[\s\S]*?setMobileToolbarMoreOpen\(false\);[\s\S]*?setSidebarOpen\(true\);/);
  assert.match(source, /const closeSidebar = useCallback\(\(\) => \{[\s\S]*?setSidebarOpen\(false\);/);
});

test("the backdrop's open state is a class the drag can write over", () => {
  assert.match(source, /className=\{`sidebar-overlay-backdrop\$\{sidebarOpen \? " is-open" : ""\}/);
  assert.match(source, /ref=\{sidebarBackdropRef\}/);
});
