// A sandbox: run commands and code, work with files, sleep and wake.
// Run: WBXSANDBOX_API_KEY=... node --experimental-strip-types examples/sandbox.ts
import { WBX } from "wbxsandbox";

const wbx = new WBX(); // API key from WBXSANDBOX_API_KEY

// A named sandbox: the next create({ name }) returns the same one (woken up if asleep).
const sandbox = await wbx.sandboxes.create({
  template: "base",
  name: "my-project",
  onTimeout: "pause", // fall asleep instead of being destroyed – files are kept
  idleTimeoutSeconds: 600,
});
console.log(sandbox.id, sandbox.state, sandbox.existing ? "(existing)" : "(new)");

const r = await sandbox.commands.run("python3 --version");
console.log(r.exitCode, r.stdout.trim());

const code = await sandbox.runCode("import sys; print(sum(range(100)), sys.version_info[:2])");
console.log(code.stdout);

await sandbox.files.write("/home/user/notes.txt", "kept while asleep\n");
console.log(await sandbox.files.readText("/home/user/notes.txt"));
console.log((await sandbox.files.list("/home/user")).map((e) => `${e.type} ${e.name}`));

// Live output of a longer command
await sandbox.commands.run("for i in 1 2 3; do echo step $i; sleep 1; done", {
  onStdout: (data) => process.stdout.write(data),
});

// Put it to sleep: files and running programs kept, no compute billed. Any request wakes it up.
await sandbox.sleep();
console.log("state:", sandbox.state);
