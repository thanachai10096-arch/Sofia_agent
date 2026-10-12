import os from "node:os";
import { createNativeDesktopDriver } from "../dist/src/desktop/native-driver.js";

if (process.env.SOFIA_DESKTOP_LIVE_TEST !== "1") {
  throw new Error("Refusing to capture the screen without explicit opt-in. Set SOFIA_DESKTOP_LIVE_TEST=1 on a dedicated test desktop.");
}

const driver = createNativeDesktopDriver();
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(new Error("Desktop smoke test timed out.")), 30_000);

try {
  // This intentionally performs read-only capture only: no click, typing, launch, or keypress.
  const capture = await driver.captureScreen();
  if (capture.mimeType !== "image/png" || capture.data.byteLength < 24) {
    throw new Error("Desktop host returned an invalid or empty PNG capture.");
  }
  if (!Number.isInteger(capture.width) || !Number.isInteger(capture.height) ||
      capture.width < 1 || capture.height < 1 || capture.width > 16384 || capture.height > 16384) {
    throw new Error("Desktop host returned invalid screen dimensions.");
  }
  console.log("Live desktop capture smoke test passed.");
  console.log(`Platform: ${os.platform()}; dimensions: ${capture.width}x${capture.height}; bytes: ${capture.data.byteLength}`);
  console.log("Screenshot bytes were not saved, uploaded, or printed.");
} finally {
  clearTimeout(timeout);
}
