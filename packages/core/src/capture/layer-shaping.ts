import * as path from 'node:path';
import { isCapturableLayer, type CapturableLayer, type KnowledgeEntry } from '../contracts/types.ts';

export interface LayerShapingContext {
  repoId: string;
  domains: string[];
  ownerId?: string;
}

/**
 * Deterministic part of the layer decision. A candidate whose claim names this repository's own files or
 * symbols is project knowledge whatever the model said (it cannot hold elsewhere); otherwise the requested
 * layer stands and the entry is shaped for its scope:
 * - shared tech / personal leave the repository: no symbol anchors or watch paths (evidence stays as provenance);
 * - domain entries get the repository's business domains;
 * - every entry records the repository it came from.
 */
export function shapeEntryForLayer(entry: KnowledgeEntry, requested: unknown, ctx: LayerShapingContext): { entry: KnowledgeEntry; downgradedFrom?: CapturableLayer } {
  let layer: CapturableLayer = isCapturableLayer(requested) ? requested : 'project';
  let downgradedFrom: CapturableLayer | undefined;
  if (layer === 'shared_tech' || layer === 'personal' || layer === 'domain') {
    const text = `${entry.title}\n${entry.claim}`.toLowerCase();
    const repoSpecific = [
      ...entry.symbol_anchors.map((a) => a.symbol_name.split('.').at(-1) ?? a.symbol_name),
      ...entry.watch_paths.map((p) => path.basename(p).replace(/\.[^.]+$/, '')),
    ].filter((t) => t.length >= 4).some((t) => text.includes(t.toLowerCase()));
    if (repoSpecific) {
      downgradedFrom = layer;
      layer = 'project';
    }
  }
  const shaped: KnowledgeEntry = { ...entry, layer, origin_repo: entry.origin_repo ?? ctx.repoId };
  if (layer === 'shared_tech' || layer === 'personal') {
    shaped.symbol_anchors = [];
    shaped.watch_paths = [];
  }
  if (layer === 'personal') {
    shaped.visibility = 'private';
    if (ctx.ownerId) shaped.owner = entry.owner ?? ctx.ownerId;
  }
  if (layer === 'domain' && !(entry.domains?.length) && ctx.domains.length) shaped.domains = [...ctx.domains];
  return downgradedFrom ? { entry: shaped, downgradedFrom } : { entry: shaped };
}
