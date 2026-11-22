import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import ts from "typescript"
import { expect, it } from "vitest"

it("Node ESM 包只导入 node:*，可在不加载 OpenCode SDK 的情况下注册工具", () => {
  const cwd = fileURLToPath(new URL("..", import.meta.url))
  const bundle = execFileSync("bun", ["build", "./src/index.ts", "--target=node", "--format=esm"], { cwd, encoding: "utf8" })
  const { importedFiles } = ts.preProcessFile(bundle, true, true)
  expect(importedFiles.length).toBeGreaterThan(0)
  expect(importedFiles.every(({ fileName }) => fileName.startsWith("node:"))).toBe(true)
  expect(bundle).not.toContain("@opencode/plugin")

  const toolNames = execFileSync(process.execPath, ["--input-type=module", "--eval", `
import { readFileSync } from "node:fs";
const source = readFileSync(0);
const { default: plugin } = await import("data:text/javascript;base64," + source.toString("base64"));
const registered = [];
await plugin.setup({ tool: { transform: (apply) => apply({
  list: () => registered,
  add: (tool) => registered.push(tool),
}) } });
console.log(JSON.stringify(registered.map(({ name }) => name)));`], {
    cwd,
    encoding: "utf8",
    input: bundle,
  })
  expect(JSON.parse(toolNames)).toEqual(["mux_run_build", "mux_service", "mux_restart", "mux_logs", "mux_input", "mux_remove", "mux_list"])
})
