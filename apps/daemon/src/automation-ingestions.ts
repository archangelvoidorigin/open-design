import { randomUUID } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type {
  AutomationCompressionReport,
  AutomationContentPacket,
  AutomationOutputSink,
  AutomationProvenanceRef,
  AutomationReviewPolicy,
  AutomationSensitivity,
  AutomationSourceIngestionResponse,
  AutomationSourceKind,
  AutomationTokenCompressionMode,
  CreateAutomationSourceIngestionRequest,
  JsonValue,
  MemoryType,
} from '@open-design/contracts';

import { createAutomationProposal, listAutomationProposals } from './automation-proposals.js';
import {
  type DesignExtractionPackage,
  type MergedSignal,
  type NormalizedDesignSystemDraft,
  buildDesignExtractionPackage,
} from './automation-design-extraction.js';
import { getAnyAutomationTemplate } from './automation-templates.js';

const STORE_DIR = 'automation-source-packets';
const STORE_FILE = 'packets.json';

const SOURCE_KINDS = new Set<AutomationSourceKind>([
  'upload',
  'url',
  'repo',
  'connector',
  'artifact',
  'chat',
]);
const SENSITIVITY_VALUES = new Set<AutomationSensitivity>([
  'public',
  'workspace',
  'private',
  'secret-adjacent',
]);
const COMPRESSION_MODES = new Set<AutomationTokenCompressionMode>(['off', 'balanced', 'aggressive']);
const REVIEW_POLICIES = new Set<AutomationReviewPolicy>(['always', 'trusted-source', 'auto-apply']);
const OUTPUT_SINKS = new Set<AutomationOutputSink>([
  'memory',
  'skill',
  'design-system',
  'automation-template',
  'artifact',
]);
const MEMORY_TYPES = new Set<MemoryType>(['user', 'feedback', 'project', 'reference']);

function storePath(dataDir: string): string {
  return path.join(dataDir, STORE_DIR, STORE_FILE);
}

async function writePackets(dataDir: string, packets: AutomationContentPacket[]): Promise<void> {
  const file = storePath(dataDir);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, JSON.stringify({ packets }, null, 2));
}

export async function listAutomationSourcePackets(
  dataDir: string,
  opts: { limit?: number } = {},
): Promise<AutomationContentPacket[]> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fsp.readFile(storePath(dataDir), 'utf8'));
  } catch {
    return [];
  }
  const packets = Array.isArray((parsed as { packets?: unknown }).packets)
    ? (parsed as { packets: AutomationContentPacket[] }).packets
    : [];
  const sorted = packets.slice().sort((a, b) => b.capturedAt.localeCompare(a.capturedAt));
  const limit = typeof opts.limit === 'number' && opts.limit > 0 ? Math.floor(opts.limit) : 0;
  return limit > 0 ? sorted.slice(0, limit) : sorted;
}

export async function getAutomationSourcePacket(
  dataDir: string,
  id: string,
): Promise<AutomationContentPacket | null> {
  const packets = await listAutomationSourcePackets(dataDir);
  return packets.find((packet) => packet.id === id) ?? null;
}

export async function listAutomationSourcePacketsForSlug(
  dataDir: string,
  slug: string,
): Promise<AutomationContentPacket[]> {
  const all = await listAutomationSourcePackets(dataDir);
  const targetRef = `design-systems/${slug}/DESIGN.md`;
  return all.filter((packet) => {
    const meta = packet.metadata as Record<string, JsonValue> | undefined;
    const ref = typeof meta?.targetRef === 'string' ? meta.targetRef : undefined;
    return ref === targetRef;
  });
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function optionalString(value: unknown): string | undefined {
  const text = asString(value);
  return text ? text : undefined;
}

function sourceKindFrom(value: unknown): AutomationSourceKind {
  if (typeof value === 'string' && SOURCE_KINDS.has(value as AutomationSourceKind)) {
    return value as AutomationSourceKind;
  }
  throw new Error('sourceKind must be one of upload, url, repo, connector, artifact, chat');
}

function sensitivityFrom(value: unknown): AutomationSensitivity {
  if (typeof value === 'string' && SENSITIVITY_VALUES.has(value as AutomationSensitivity)) {
    return value as AutomationSensitivity;
  }
  return 'workspace';
}

function compressionModeFrom(
  value: unknown,
  fallback: AutomationTokenCompressionMode,
): AutomationTokenCompressionMode {
  if (typeof value === 'string' && COMPRESSION_MODES.has(value as AutomationTokenCompressionMode)) {
    return value as AutomationTokenCompressionMode;
  }
  return fallback;
}

function reviewPolicyFrom(value: unknown, fallback: AutomationReviewPolicy): AutomationReviewPolicy {
  if (typeof value === 'string' && REVIEW_POLICIES.has(value as AutomationReviewPolicy)) {
    return value as AutomationReviewPolicy;
  }
  return fallback;
}

function memoryTypeFrom(value: unknown): MemoryType {
  if (typeof value === 'string' && MEMORY_TYPES.has(value as MemoryType)) {
    return value as MemoryType;
  }
  return 'project';
}

function outputSinksFrom(
  value: unknown,
  fallback: AutomationOutputSink[],
): AutomationOutputSink[] {
  const raw = Array.isArray(value) ? value : fallback;
  const out: AutomationOutputSink[] = [];
  for (const item of raw) {
    if (typeof item !== 'string' || !OUTPUT_SINKS.has(item as AutomationOutputSink)) continue;
    const sink = item as AutomationOutputSink;
    if (!out.includes(sink)) out.push(sink);
  }
  return out.length > 0 ? out : ['memory'];
}

function estimateTokens(text: string): number {
  if (!text.trim()) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

function slugify(value: string): string {
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-')
    .slice(0, 60);
  return cleaned || `source-${randomUUID().slice(0, 8)}`;
}

function firstLineTitle(body: string): string {
  const line = body
    .split(/\r?\n/)
    .map((item) => item.replace(/^#+\s*/, '').trim())
    .find(Boolean);
  return line ? line.slice(0, 100) : '';
}

const MAX_CHARS_MAP = { off: Infinity, balanced: 3_200, aggressive: 1_600 } as const;

function compactMarkdown(
  body: string,
  mode: AutomationTokenCompressionMode,
  packetId: string,
): { body: string; report: AutomationCompressionReport } {
  const beforeTokens = estimateTokens(body);
  if (mode === 'off') {
    return {
      body,
      report: {
        mode,
        status: 'skipped',
        beforeTokens,
        afterTokens: beforeTokens,
        summary: 'Token compression disabled for this ingestion.',
        preservedSourcePacketId: packetId,
      },
    };
  }

  const maxChars = MAX_CHARS_MAP[mode] ?? 3_200;
  if (body.length <= maxChars) {
    return {
      body,
      report: {
        mode,
        status: 'skipped',
        beforeTokens,
        afterTokens: beforeTokens,
        summary: 'Source packet was already below the compression threshold.',
        preservedSourcePacketId: packetId,
      },
    };
  }

  const head = body.slice(0, maxChars).trimEnd();
  const omittedTokens = estimateTokens(body.slice(maxChars));
  const compressed = [head, '', `> Automation compression preserved the original packet (${packetId}) and omitted roughly ${omittedTokens} tokens from this proposal preview.`].join('\n');
  const afterTokens = estimateTokens(compressed);
  return {
    body: compressed,
    report: {
      mode,
      status: 'applied',
      beforeTokens,
      afterTokens,
      summary:
        mode === 'aggressive'
          ? 'Kept the leading durable context and preserved the full source packet for audit.'
          : 'Trimmed oversized source context while preserving provenance to the full packet.',
      preservedSourcePacketId: packetId,
    },
  };
}

function buildProvenance(input: {
  sourceKind: AutomationSourceKind;
  sourceRef: string;
  title: string;
  connectorId?: string;
  accountLabel?: string;
}): AutomationProvenanceRef[] {
  const labelParts = [input.connectorId, input.accountLabel, input.title].filter(Boolean);
  return [
    {
      kind: input.sourceKind,
      label: labelParts.length > 0 ? labelParts.join(' / ') : input.title,
      ref: input.sourceRef,
      ...(input.sourceRef.startsWith('http://') || input.sourceRef.startsWith('https://') ? { url: input.sourceRef } : {}),
    },
  ];
}

function buildMemoryProposalPatch(input: {
  title: string;
  sourceKind: AutomationSourceKind;
  sourceRef: string;
  body: string;
  memoryType: MemoryType;
  packetId: string;
}) {
  return {
    format: 'json' as const,
    after: JSON.stringify(
      {
        name: input.title,
        description: `Ingested from ${input.sourceKind}: ${input.sourceRef}`,
        type: input.memoryType,
        body: [`# ${input.title}`, '', `Source: ${input.sourceKind} ${input.sourceRef}`, `Source packet: ${input.packetId}`, '', input.body].join('\n'),
      },
      null,
      2,
    ),
    diffSummary: 'Creates one editable memory-tree entry from the ingested source packet.',
  };
}

type DesignSystemProposalMarkdownInput = {
  title: string;
  sourceKind: AutomationSourceKind;
  sourceRef: string;
  body: string;
  packetId: string;
  draft?: NormalizedDesignSystemDraft;
  mergedSignals?: MergedSignal[];
  priorProposalId?: string;
  priorProposalTitle?: string;
};

function buildDesignSystemProposalMarkdown(input: DesignSystemProposalMarkdownInput): string {
  const { title, sourceKind, sourceRef, body, packetId, draft, mergedSignals, priorProposalId, priorProposalTitle } = input;

  const lines: string[] = [`# ${title} Design System`, '', '> Category: Self-evolved', '> Surface: web', ''];

  lines.push('## Source Provenance', '');
  lines.push(`- Source kind: ${sourceKind}`);
  lines.push(`- Source ref: ${sourceRef}`);
  lines.push(`- Source packet: ${packetId}`);

  if (priorProposalId) {
    lines.push(`- Prior proposal: ${priorProposalTitle} (${priorProposalId})`);
    lines.push('');
    lines.push('## Reconciliation', '');
    lines.push(`This proposal supersedes [${priorProposalTitle}](${priorProposalId}). Review the evolution between the prior draft and this one before applying.`);
    lines.push('');
  }

  lines.push('## Extracted Direction', '');
  lines.push(body);

  if (draft && mergedSignals && mergedSignals.length > 0) {
    lines.push('', '## Extracted Signals', '');
    lines.push('Merged design signals detected from the source, deduped by value:', '');
    lines.push('| Kind | Value | Confidence | Occurrences |');
    lines.push('|------|-------|-----------|-------------|');
    for (const s of mergedSignals.slice(0, 40)) {
      const ctx = s.contexts[0]?.replace(/\|/g, '\\|').slice(0, 60) ?? '';
      lines.push(`| ${s.kind} | ${s.value} | ${s.confidence} | ${s.occurrences} |`);
    }

    if (Object.keys(draft.colorTokens).length > 0) {
      lines.push('', '### Color tokens (preliminary)', '');
      lines.push('```css');
      for (const [k, v] of Object.entries(draft.colorTokens)) {
        lines.push(`${k}: ${v};`);
      }
      lines.push('```');
    }

    if (Object.keys(draft.fontTokens).length > 0) {
      lines.push('', '### Font tokens (preliminary)', '');
      lines.push('```css');
      for (const [k, v] of Object.entries(draft.fontTokens)) {
        lines.push(`${k}: ${v};`);
      }
      lines.push('```');
    }

    if (Object.keys(draft.spacingTokens).length > 0) {
      lines.push('', '### Spacing tokens (preliminary)', '');
      lines.push('```css');
      for (const [k, v] of Object.entries(draft.spacingTokens)) {
        lines.push(`${k}: ${v};`);
      }
      lines.push('```');
    }

    lines.push('', '### Reviewer prompts', '');
    for (const prompt of draft.reviewerPrompts) {
      lines.push(`- ${prompt}`);
    }

    if (draft.layoutPosture.length > 0) {
      lines.push('', '### Layout posture', '');
      for (const posture of draft.layoutPosture) {
        lines.push(`- ${posture}`);
      }
    }

    if (draft.components.length > 0) {
      lines.push('', '### Detected component vocabulary', '');
      lines.push(draft.components.map((c) => `- ${c}`).join('\n'));
    }
  }

  lines.push('', '## Evolution Notes', '');
  lines.push('- Review, rename, and tighten tokens before promoting this into the active catalogue.');
  lines.push('- Values in the Extracted Signals table are signals, not endorsed decisions.');
  lines.push('- Resolve any low-confidence entries before applying.');

  return lines.join('\n');
}

function buildSkillProposalMarkdown(input: {
  title: string;
  sourceKind: AutomationSourceKind;
  sourceRef: string;
  body: string;
  packetId: string;
}): string {
  const name = `${input.title} skill`;
  return [
    '---',
    `name: "${name.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`,
    `description: "Self-evolved from ${input.sourceKind} ${input.sourceRef}"`,
    'triggers:',
    ` - "${input.title.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`,
    '---',
    '',
    `# ${name}`,
    '',
    `Source packet: ${input.packetId}`,
    '',
    '## When To Use',
    '',
    'Use this skill when a future request matches the workflow or reusable design guidance below.',
    '',
    '## Workflow',
    '',
    input.body,
  ].join('\n');
}

async function persistPacket(dataDir: string, packet: AutomationContentPacket): Promise<void> {
  const packets = await listAutomationSourcePackets(dataDir);
  const next = packets.filter((existing) => existing.id !== packet.id);
  next.push(packet);
  await writePackets(dataDir, next);
}

function jsonObjectFrom(value: unknown): Record<string, JsonValue> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, JsonValue>;
}

async function findPriorProposalForSlug(
  dataDir: string,
  slug: string,
): Promise<{ id: string; title: string } | null> {
  const all = await listAutomationProposals(dataDir, { status: 'all' });
  const target = `design-systems/${slug}/DESIGN.md`;
  const match = all.find((p) => p.targetRef === target && p.status === 'applied');
  return match ? { id: match.id, title: match.title } : null;
}

function shouldRunDesignExtraction(templateId: string | undefined, candidateSinks: AutomationOutputSink[]): boolean {
  if (candidateSinks.includes('design-system')) return true;
  if (templateId === 'extract-design-system') return true;
  if (templateId === 'promote-artifact-style') return true;
  return false;
}

export async function ingestAutomationSource(
  dataDir: string,
  input: CreateAutomationSourceIngestionRequest,
): Promise<AutomationSourceIngestionResponse> {
  if (!input || typeof input !== 'object') {
    throw new Error('ingestion body is required');
  }
  const sourceKind = sourceKindFrom(input.sourceKind);
  const bodyMarkdown = typeof input.bodyMarkdown === 'string' ? input.bodyMarkdown.trim() : '';
  if (!bodyMarkdown) throw new Error('bodyMarkdown is required');

  const template = input.templateId ? await getAnyAutomationTemplate(dataDir, input.templateId) : null;
  const templateSinks = template?.outputSinks ?? ['memory'];
  const candidateSinks = outputSinksFrom(input.candidateSinks, templateSinks);
  const reviewPolicy = reviewPolicyFrom(input.reviewPolicy, template?.reviewPolicy ?? 'always');
  const tokenCompression = compressionModeFrom(
    input.tokenCompression,
    template?.tokenCompression ?? 'balanced',
  );

  const packetId = `packet_${randomUUID()}`;
  const sourceEventId = `source_event_${randomUUID()}`;
  const capturedAt = new Date().toISOString();
  const sourceRef =
    optionalString(input.sourceRef) ??
    optionalString(input.connectorId) ??
    optionalString(input.artifactId) ??
    optionalString(input.conversationId) ??
    sourceKind;
  const title = optionalString(input.title) ?? firstLineTitle(bodyMarkdown) ?? `${sourceKind} source`;
  const sensitivity = sensitivityFrom(input.sensitivity);
  const capabilityHints = Array.isArray(input.capabilityHints)
    ? input.capabilityHints.filter((hint): hint is string => typeof hint === 'string' && hint.length > 0)
    : input.connectorId
      ? [`connector:${input.connectorId}`]
      : [];

  const runDesignExtraction = shouldRunDesignExtraction(input.templateId, candidateSinks);
  const designExtractionPackage = runDesignExtraction ? buildDesignExtractionPackage(bodyMarkdown, title) : null;

  const metadata: Record<string, JsonValue> = jsonObjectFrom(input.metadata);
  if (template) metadata.templateId = template.id;
  const projectId = optionalString(input.projectId);
  const artifactId = optionalString(input.artifactId);
  const connectorId = optionalString(input.connectorId);
  const accountLabel = optionalString(input.accountLabel);
  const conversationId = optionalString(input.conversationId);
  if (projectId) metadata.projectId = projectId;
  if (connectorId) metadata.connectorId = connectorId;
  if (accountLabel) metadata.accountLabel = accountLabel;
  if (artifactId) metadata.artifactId = artifactId;
  if (conversationId) metadata.conversationId = conversationId;

  if (designExtractionPackage) {
    metadata.designExtraction = {
      signalCount: designExtractionPackage.signals.length,
      mergedCount: designExtractionPackage.merged.length,
      signalKinds: [...new Set(designExtractionPackage.merged.map((m) => m.kind))],
      extractionWarnings: designExtractionPackage.extractionWarnings,
      topSignals: designExtractionPackage.merged.slice(0, 10).map((m) => ({ kind: m.kind, value: m.value, confidence: m.confidence, occurrences: m.occurrences })),
    } as JsonValue;
  }

  const packet: AutomationContentPacket = {
    id: packetId,
    sourceEventId,
    sourceKind,
    sourceRef,
    title,
    capturedAt,
    bodyMarkdown,
    provenance: buildProvenance({
    sourceKind,
    sourceRef,
    title,
    ...(connectorId ? { connectorId } : {}),
    ...(accountLabel ? { accountLabel } : {}),
  }),
    attachments: [],
    sensitivity,
    capabilityHints,
    tokenStats: { originalTokens: estimateTokens(bodyMarkdown), canonicalTokens: estimateTokens(bodyMarkdown) },
    candidateSinks,
  };
  if (Object.keys(metadata).length > 0) packet.metadata = metadata;

  await persistPacket(dataDir, packet);

  const { body: proposalBody, report } = compactMarkdown(bodyMarkdown, tokenCompression, packetId);
  const memoryType = memoryTypeFrom(input.memoryType);
  const proposals: AutomationSourceIngestionResponse['proposals'] = [];
  const lineageMetadata: Record<string, JsonValue> = {
    sourceKind,
    sourceRef,
    ...(template ? { templateId: template.id } : {}),
    capturedAt,
    designSignalCount: designExtractionPackage ? designExtractionPackage.signals.length : 0,
  };

  if (candidateSinks.includes('memory')) {
    proposals.push(
      await createAutomationProposal(dataDir, {
        title: `Memory: ${title}`,
        summary: `Create a memory-tree entry from ${sourceKind} source ${sourceRef}.`,
        targetKind: 'memory-node',
        action: 'create',
        reviewPolicy,
        sourcePacketIds: [packet.id],
        patch: buildMemoryProposalPatch({ title, sourceKind, sourceRef, body: proposalBody, memoryType, packetId: packet.id }),
        compressionReport: report,
        metadata: lineageMetadata,
      }),
    );
  }

  if (candidateSinks.includes('design-system')) {
    const slug = slugify(title);
    const priorProposal = await findPriorProposalForSlug(dataDir, slug);
    const designSystemProposalInput: DesignSystemProposalMarkdownInput = {
      title,
      sourceKind,
      sourceRef,
      body: proposalBody,
      packetId: packet.id,
    };
    if (designExtractionPackage) {
      designSystemProposalInput.draft = designExtractionPackage.draft;
      designSystemProposalInput.mergedSignals = designExtractionPackage.merged;
    }
    if (priorProposal) {
      designSystemProposalInput.priorProposalId = priorProposal.id;
      designSystemProposalInput.priorProposalTitle = priorProposal.title;
    }

    const enhancedBody = buildDesignSystemProposalMarkdown(designSystemProposalInput);
    const designSystemLineage = {
      ...lineageMetadata,
      slug,
      ...(priorProposal ? { priorProposalId: priorProposal.id, priorProposalTitle: priorProposal.title } : {}),
      extractedSignalsCount: designExtractionPackage ? designExtractionPackage.signals.length : 0,
      signalKinds: designExtractionPackage ? [...new Set(designExtractionPackage.merged.map((m) => m.kind))] : [],
    };

    proposals.push(
      await createAutomationProposal(dataDir, {
        title: `Design system: ${title}`,
        summary: `Draft a DESIGN.md proposal from ${sourceKind} source ${sourceRef}.`,
        targetKind: 'design-system',
        action: 'create',
        reviewPolicy,
        sourcePacketIds: [packet.id],
        targetRef: `design-systems/${slug}/DESIGN.md`,
        patch: { format: 'markdown', after: enhancedBody, diffSummary: 'Creates a reviewable DESIGN.md draft from the source packet.' },
        compressionReport: report,
        metadata: designSystemLineage,
      }),
    );
  }

  if (candidateSinks.includes('skill')) {
    const slug = slugify(title);
    proposals.push(
      await createAutomationProposal(dataDir, {
        title: `Skill: ${title}`,
        summary: `Draft a reusable SKILL.md proposal from ${sourceKind} source ${sourceRef}.`,
        targetKind: 'skill',
        action: 'create',
        reviewPolicy,
        sourcePacketIds: [packet.id],
        targetRef: `skills/${slug}/SKILL.md`,
        patch: { format: 'markdown', after: buildSkillProposalMarkdown({ title, sourceKind, sourceRef, body: proposalBody, packetId: packet.id }), diffSummary: 'Creates a reviewable SKILL.md draft from the source packet.' },
        compressionReport: report,
        metadata: { ...lineageMetadata, slug },
      }),
    );
  }

  return {
    packet,
    proposals,
    compressionReport: report,
  };
}
