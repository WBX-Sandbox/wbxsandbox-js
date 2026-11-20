// The desktop of a sandbox (template "desktop", feature "desktop"): screenshot and click.
import { writeFile } from "node:fs/promises";

import { ComputerActionError, HumanInControlError, WBX } from "wbxsandbox";

const wbx = new WBX();

const features = await wbx.features();
if (!features.desktop) throw new Error("the desktop feature is not enabled for this account");

const sandbox = await wbx.sandboxes.create({ template: "desktop" });
try {
  const status = await sandbox.computer.status();
  console.log(status.width, "x", status.height, "controlled by", status.controller);
  if (status.controller_until !== null) {
    console.log("a person keeps control for", Math.round((status.controller_until - Date.now()) / 1000), "s at most");
  }

  // a scaled-down screenshot: width/height are the image, screenWidth/screenHeight the screen
  const shot = await sandbox.computer.screenshot({ format: "jpeg", quality: 70, maxWidth: 1024 });
  await writeFile("desktop.jpg", shot.data);
  console.log("image", shot.width, "x", shot.height, "of a", shot.screenWidth, "x", shot.screenHeight, "screen");

  // click in the middle, type, press Enter – and get a screenshot of the result in the same call
  await sandbox.computer.click(Math.round(status.width / 2), Math.round(status.height / 2));
  await sandbox.computer.type("hello from an agent");
  const r = await sandbox.computer.key("Return", { screenshot: true, screenshotFormat: "png" });
  if (r.screenshot) await writeFile("after.png", r.screenshot.data);
  else if (r.screenshotError) console.log("no screenshot:", r.screenshotError);

  // several actions in one request; mouse_down / mouse_up take x and y together, or neither
  await sandbox.computer.actions([
    { type: "key", keys: "ctrl+a" },
    { type: "wait", ms: 200 },
    { type: "mouse_down", x: 100, y: 100 },
    { type: "move", x: 300, y: 200 },
    { type: "mouse_up" },
    { type: "scroll", x: 400, y: 300, dx: 0, dy: 5 },
  ]);

  // a failed action stops the list: by default ComputerActionError, or inspect the result
  const soft = await sandbox.computer.actions([{ type: "key", keys: "ctrl+shift+t" }], { throwOnFailure: false });
  if (!soft.ok) console.log(`action ${soft.failedIndex} failed: ${soft.error}`);
} catch (e) {
  if (e instanceof HumanInControlError) console.log("a person is using the desktop right now – try again later");
  else if (e instanceof ComputerActionError) console.log(`action ${e.failedIndex} failed: ${e.message}`);
  else throw e;
} finally {
  await sandbox.kill();
}
