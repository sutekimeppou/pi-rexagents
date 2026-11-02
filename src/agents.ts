import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { AgentDefinition } from "./state.ts";

type AgentFrontmatter = Partial<Omit<AgentDefinition, "prompt" | "tools">> & { tools?: string | string[] };

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
  const { frontmatter: data, body } = parseFrontmatter<AgentFrontmatter>(text);
  const tools = typeof data.tools === "string"
    ? data.tools === "none" ? [] : data.tools.split(",").map((tool) => tool.trim()).filter(Boolean)
    : data.tools;
  return {
    name: data.name || fallbackName,
    description: data.description || fallbackName,
    prompt: body,
    model: data.model,
    thinking: data.thinking,
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
