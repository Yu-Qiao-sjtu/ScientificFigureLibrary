import fs from "node:fs/promises";
import path from "node:path";
import type { ModuleCatalogEntry, ModuleCatalog } from "./types.ts";

/**
 * Runtime-only location for the durable Open Figure Modules Source Pack.
 * The bundled bootstrap snapshot intentionally remains under assets/personal-modules.
 */
export const OPEN_MODULES_SOURCE_PACK_RELATIVE = path.join("source-packs", "open-modules");

export type ArchiveTransportKind = "gitee-mirror" | "github-upstream";

export interface ArchiveTransportSource {
  kind: ArchiveTransportKind;
  urlTemplate: string;
  priority?: number;
}

export function defaultOpenModulesSourcePackDir(globalLibraryRoot: string) {
  return path.resolve(globalLibraryRoot, OPEN_MODULES_SOURCE_PACK_RELATIVE);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sourceKind(value: unknown): ArchiveTransportKind {
  if (value === "gitee-mirror" || value === "github-upstream") return value;
  throw new Error("archive source kind is invalid");
}

function validateTemplate(template: unknown, label: string) {
  if (typeof template !== "string" || !template.trim() || template.length > 4_000) {
    throw new Error(`${label} must be a non-empty URL template`);
  }
  if (!template.startsWith("https://")) throw new Error(`${label} must use HTTPS`);
  if (template.includes("\\") || template.includes("#") || template.includes("@")) {
    throw new Error(`${label} contains unsupported URL characters`);
  }
  return template;
}

function parseSource(value: unknown, label: string): ArchiveTransportSource {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  const kind = sourceKind(value.kind);
  const urlTemplate = validateTemplate(value.urlTemplate, `${label}.urlTemplate`);
  const parsed = new URL(urlTemplate.replaceAll("{archiveCommit}", "0000000000000000000000000000000000000000")
    .replaceAll("{archivePath}", "archives/module.zip")
    .replaceAll("{moduleId}", "module"));
  const allowedHost = kind === "gitee-mirror" ? "gitee.com" : "raw.githubusercontent.com";
  if (parsed.hostname.toLocaleLowerCase("en-US") !== allowedHost) {
    throw new Error(`${label}.urlTemplate must target ${allowedHost}`);
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(`${label}.urlTemplate must not contain credentials, query, or hash`);
  }
  const priority = value.priority === undefined ? undefined : Number(value.priority);
  if (priority !== undefined && (!Number.isSafeInteger(priority) || priority < 0 || priority > 10_000)) {
    throw new Error(`${label}.priority is invalid`);
  }
  return { kind, urlTemplate, ...(priority === undefined ? {} : { priority }) };
}

export function parseArchiveTransportSources(value: unknown, label = "archiveSources") {
  if (!Array.isArray(value) || value.length > 32) throw new Error(`${label} must be an array`);
  const sources = value.map((item, index) => parseSource(item, `${label}[${index}]`));
  const seen = new Set<string>();
  for (const source of sources) {
    const key = `${source.kind}\n${source.urlTemplate}`;
    if (seen.has(key)) throw new Error(`${label} contains duplicate sources`);
    seen.add(key);
  }
  return sources.sort((left, right) =>
    (left.priority ?? 100) - (right.priority ?? 100) ||
    left.kind.localeCompare(right.kind) ||
    left.urlTemplate.localeCompare(right.urlTemplate),
  );
}

function renderTemplate(template: string, module: ModuleCatalogEntry) {
  const rendered = template
    .replaceAll("{moduleId}", encodeURIComponent(module.moduleId))
    .replaceAll("{archiveCommit}", encodeURIComponent(module.archive.commit))
    .replaceAll(
      "{archivePath}",
      module.archive.path.split("/").map((part) => encodeURIComponent(part)).join("/"),
    );
  const parsed = new URL(rendered);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("archive source rendered an unsafe URL");
  }
  return parsed.href;
}

export function renderArchiveTransportUrl(source: ArchiveTransportSource, module: ModuleCatalogEntry) {
  return renderTemplate(source.urlTemplate, module);
}

export function githubArchiveSource(module: ModuleCatalogEntry): ArchiveTransportSource {
  const [owner, repository] = module.archive.repository.split("/");
  if (!owner || !repository) throw new Error("module archive repository is invalid");
  const encodedPath = module.archive.path.split("/").map((part) => encodeURIComponent(part)).join("/");
  return {
    kind: "github-upstream",
    urlTemplate: `https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/{archiveCommit}/{archivePath}`,
    priority: 10_000,
  };
}

interface MirrorConfig {
  openModules?: {
    sources?: unknown;
  };
}

/** Read optional machine-local transport overrides without changing canonical identity. */
export async function readOpenModulesMirrorSources(sourcePackDir?: string) {
  if (!sourcePackDir) return [] as ArchiveTransportSource[];
  const root = path.resolve(sourcePackDir);
  const configPath = path.join(root, "..", "..", "network", "mirrors.json");
  let raw: string;
  try {
    raw = await fs.readFile(configPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new Error(`Open Modules mirror configuration cannot be read: ${error instanceof Error ? error.message : String(error)}`);
  }
  let value: MirrorConfig;
  try {
    value = JSON.parse(raw) as MirrorConfig;
  } catch (error) {
    throw new Error(`Open Modules mirror configuration is invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(value)) throw new Error("Open Modules mirror configuration must be an object");
  const section = value.openModules;
  if (section === undefined) return [] as ArchiveTransportSource[];
  if (!isRecord(section)) throw new Error("Open Modules mirror configuration.openModules must be an object");
  if (section.sources === undefined) return [] as ArchiveTransportSource[];
  return parseArchiveTransportSources(section.sources, "network.mirrors.openModules.sources");
}

export function catalogArchiveSources(catalog: ModuleCatalog) {
  const sources = catalog.provider.archiveSources ?? [];
  return parseArchiveTransportSources(sources, "catalog.provider.archiveSources");
}
