import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

export async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "model-prompts-"))
  const previous = {
    HOME: process.env.HOME,
    OPENCODE_TEST_HOME: process.env.OPENCODE_TEST_HOME,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  }
  process.env.HOME = root
  process.env.OPENCODE_TEST_HOME = root
  delete process.env.XDG_CONFIG_HOME
  const global = path.join(root, ".config", "opencode")
  const project = path.join(root, "project")
  await fs.mkdir(global, { recursive: true })
  await fs.mkdir(project, { recursive: true })
  return {
    root,
    global,
    project,
    async write(file: string, text: string) {
      await fs.mkdir(path.dirname(file), { recursive: true })
      await fs.writeFile(file, text)
    },
    async cleanup() {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key as keyof typeof previous]
        else process.env[key as keyof typeof previous] = value
      }
      await fs.rm(root, { recursive: true, force: true })
    },
  }
}
