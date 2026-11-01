import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { AgentDefinition } from "./state.ts";

const SUPPORTED = new Set([
  "name", "description", "model", "thinking", "tools", "prompt_mode",
  "extensions", "skills", "allowed_subagents",
]);

export function discoverAgents(): Map<string, { path: string; description: string }> {
  const directory = join(getAgentDir(), "agents");
  let files;
  try {
    files = readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Map();
    throw error;
  }
  const agents = new Map<string, { path: string; description: string }>();
  for (const file of files.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!file.name.endsWith(".md") || (!file.isFile() && !file.isSymbolicLink())) continue;
    const path = join(directory, file.name);
    const { frontmatter } = parseFrontmatter<Record<string, unknown>>(readFileSync(path, "utf8"));
    const name = typeof frontmatter.name === "string" ? frontmatter.name : file.name.slice(0, -3);
    agents.set(name, { path, description: String(frontmatter.description ?? name) });
  }
  return agents;
}

export function parseAgent(text: string, fallbackName: string): AgentDefinition {
  const { frontmatter: data, body } = parseFrontmatter<Record<string, unknown>>(text);
  for (const key of Object.keys(data)) {
    if (!SUPPORTED.has(key)) throw new Error(`Unsupported agent setting "${key}" in ${fallbackName}`);
  }
  if (data.prompt_mode !== undefined && data.prompt_mode !== "append") {
    throw new Error("Rex workers support prompt_mode: append");
  }
  if (data.allowed_subagents !== undefined && data.allowed_subagents !== "none") {
    throw new Error("Nested delegation is disabled. Use allowed_subagents: none");
  }
  for (const key of ["extensions", "skills"]) {
    if (data[key] !== undefined && typeof data[key] !== "boolean") throw new Error(`${key} must be a boolean`);
  }
  for (const key of ["name", "description", "model", "thinking"]) {
    if (data[key] !== undefined && typeof data[key] !== "string") throw new Error(`${key} must be a string`);
  }
  let tools: string[] | undefined;
  if (data.tools !== undefined) {
    if (typeof data.tools === "string") tools = data.tools === "none" ? [] : data.tools.split(",").map((s) => s.trim()).filter(Boolean);
    else if (Array.isArray(data.tools) && data.tools.every((tool) => typeof tool === "string")) tools = data.tools;
    else throw new Error("tools must be a comma-separated string or string array");
    if (tools.some((tool) => tool.startsWith("ext:"))) throw new Error("ext: tool selectors are unsupported; use Pi tool names");
  }
  return {
    name: data.name as string || fallbackName,
    description: data.description as string || fallbackName,
    prompt: body,
    model: data.model as string | undefined,
    thinking: data.thinking as string | undefined,
    tools,
    extensions: data.extensions !== false,
    skills: data.skills !== false,
  };
}

export function loadAgent(name: string): AgentDefinition {
  const agent = discoverAgents().get(name);
  if (!agent) throw new Error(`Unknown agent "${name}". Available: ${[...discoverAgents().keys()].join(", ") || "none"}`);
  return parseAgent(readFileSync(agent.path, "utf8"), name);
}
