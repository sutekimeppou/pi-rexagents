export function formatWorkerStatus(count: number): string {
  return `${count} ${count === 1 ? "rexagent" : "rexagents"}`;
}
