// A framework-agnostic tool an AI agent can call: "run this Python code and tell me the result".
// Plug the definition and the function into any model API or agent framework that supports
// function calling – the shape (name, description, JSON Schema, async function) is universal.
import { WBX, type Sandbox } from "wbxsandbox";

const wbx = new WBX();

/** JSON Schema description of the tool for the model. */
export const runPythonTool = {
  name: "run_python",
  description:
    "Run Python 3 code in an isolated Linux sandbox and return its standard output and errors. " +
    "Files written under /home/user are kept between calls in the same conversation.",
  parameters: {
    type: "object",
    properties: {
      code: { type: "string", description: "The Python code to run." },
    },
    required: ["code"],
    additionalProperties: false,
  },
} as const;

/** One sandbox per conversation, reused between calls and asleep when unused. */
const sandboxes = new Map<string, Promise<Sandbox>>();

function sandboxFor(conversationId: string): Promise<Sandbox> {
  let sb = sandboxes.get(conversationId);
  if (!sb) {
    sb = wbx.sandboxes.create({
      template: "base",
      name: `conv-${conversationId}`.toLowerCase().replace(/[^a-z0-9._-]/g, "-").slice(0, 63),
      onTimeout: "pause",
      idleTimeoutSeconds: 600,
      network: { mode: "allowlist", allow: ["pypi.org", "files.pythonhosted.org"] },
    });
    sandboxes.set(conversationId, sb);
    sb.catch(() => sandboxes.delete(conversationId));
  }
  return sb;
}

/** The function the agent calls. Returns text for the model – never throws for a failing script. */
export async function runPython(conversationId: string, args: { code: string }, signal?: AbortSignal): Promise<string> {
  const sandbox = await sandboxFor(conversationId);
  const r = await sandbox.runCode(args.code, { timeoutMs: 120_000, signal });
  const out = [`exit code: ${r.exitCode}${r.timedOut ? " (timed out after 120 s)" : ""}`];
  if (r.stdout) out.push(`stdout:\n${r.stdout.slice(-8000)}`);
  if (r.stderr) out.push(`stderr:\n${r.stderr.slice(-4000)}`);
  return out.join("\n");
}

// Example: what your agent loop does when the model asks for the tool
if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(runPythonTool.name, "→");
  console.log(await runPython("demo-1", { code: "import platform; print(platform.platform())" }));
  await (await sandboxFor("demo-1")).sleep();
}
