import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import path from "node:path";
import { WindowsFileGuard } from "../../../validation/windows-file-guard.js";
import type { Chat, Project } from "../../shared/contracts.js";

export function assertProjectDataSeparation(root: string, dataRoot: string): void {
  const project = realpathSync(root), data = realpathSync(dataRoot);
  const within = (base: string, candidate: string) => {
    const relative = path.relative(base, candidate);
    return !relative || (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative));
  };
  if (within(project, data) || within(data, project)) throw new Error("PROJECT_OVERLAPS_APP_DATA");
}

export async function inspectProject(root: string, guard: WindowsFileGuard): Promise<Project> {
  const actual = realpathSync(root);
  const captured = await guard.capture(actual);
  return { id: randomUUID(), name: path.basename(actual), path: actual, files: captured.files.filter(file => file.kind === "text").map(file => file.relative).sort(), excluded: captured.excluded.length };
}
export function newChat(projectId: string): Chat {
  return { id: randomUUID(), projectId, title: "新聊天", mode: "read", execution: "idle", verification: "unverified", messages: [], tools: [], changes: [], error: null, reviewId: null };
}
export async function previewFile(project: Project, relative: string, guard: WindowsFileGuard) {
  // The renderer sends a selection from the registered project's captured list,
  // never an absolute path or an arbitrary filesystem read capability.
  if (!project.files.includes(relative)) throw new Error("FILE_OUTSIDE_SELECTION");
  const captured = await guard.capture(project.path);
  const file = captured.files.find(item => item.relative === relative && item.kind === "text");
  if (!file) throw new Error("FILE_UNAVAILABLE");
  return { relative, text: Buffer.from(file.base64, "base64").toString("utf8") };
}
