import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { JsonValue } from '@open-design/contracts';

import {
  getAutomationSourcePacket,
  ingestAutomationSource,
  listAutomationSourcePackets,
  listAutomationSourcePacketsForSlug,
} from '../src/automation-ingestions.js';
import {
  applyAutomationProposal,
  listAutomationProposals,
} from '../src/automation-proposals.js';
import {
  buildDesignExtractionPackage,
  extractDesignSignals,
} from '../src/automation-design-extraction.js';
import { buildMemoryTree, readMemoryEntry } from '../src/memory.js';

let dataDir = '';

beforeEach(async () => {
  dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'od-automation-ingestions-'));
});

afterEach(async () => {
  await fsp.rm(dataDir, { recursive: true, force: true });
});

describe('automation source ingestion', () => {
  it('persists a connector source packet and creates an applyable memory proposal', async () => {
    const result = await ingestAutomationSource(dataDir, {
      templateId: 'connector-digest-design-context',
      sourceKind: 'connector',
      sourceRef: 'slack://C123/1710000000.000',
      connectorId: 'slack',
      accountLabel: 'Design Ops',
      title: 'Design review decision',
      bodyMarkdown: 'Decision: keep design-system extraction behind human review.',
      tokenCompression: 'off',
    });

    expect(result.packet).toMatchObject({
      sourceKind: 'connector',
      title: 'Design review decision',
      sourceRef: 'slack://C123/1710000000.000',
      candidateSinks: ['memory', 'artifact'],
    });
    expect(result.packet.capabilityHints).toEqual(['connector:slack']);
    expect(result.compressionReport).toMatchObject({
      mode: 'off',
      status: 'skipped',
      preservedSourcePacketId: result.packet.id,
    });
    expect(await getAutomationSourcePacket(dataDir, result.packet.id)).toMatchObject({
      id: result.packet.id,
    });

    const proposals = await listAutomationProposals(dataDir, { status: 'pending-review' });
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({
      targetKind: 'memory-node',
      sourcePacketIds: [result.packet.id],
      compressionReport: {
        preservedSourcePacketId: result.packet.id,
      },
    });

    const applied = await applyAutomationProposal(dataDir, proposals[0]!.id);
    const memoryId = (applied.result as { memoryId: string }).memoryId;
    const entry = await readMemoryEntry(dataDir, memoryId);
    expect(entry?.body).toContain('keep design-system extraction behind human review');
    const tree = await buildMemoryTree(dataDir);
    expect(tree.find((node) => node.id === memoryId)).toMatchObject({
      sourcePacketIds: [result.packet.id],
      proposalIds: [proposals[0]!.id],
    });
  });

  it('uses design-system templates to draft design-system and memory proposals with compression evidence', async () => {
    const longBody = `# Brand notes\n\n${'Primary action color #335CFF. Use dense product dashboards. '.repeat(400)}`;
    const result = await ingestAutomationSource(dataDir, {
      templateId: 'extract-design-system',
      sourceKind: 'repo',
      sourceRef: 'https://github.com/acme/design',
      title: 'Acme brand notes',
      bodyMarkdown: longBody,
      tokenCompression: 'aggressive',
    });

    expect(result.compressionReport.status).toBe('applied');
    expect(result.compressionReport.afterTokens).toBeLessThan(
      result.compressionReport.beforeTokens,
    );
    expect(result.proposals.map((proposal) => proposal.targetKind).sort()).toEqual([
      'design-system',
      'memory-node',
    ]);
    expect(result.proposals.find((proposal) => proposal.targetKind === 'design-system')?.patch.after)
      .toContain('Acme brand notes Design System');

    const packets = await listAutomationSourcePackets(dataDir);
    expect(packets.map((packet) => packet.id)).toContain(result.packet.id);
  });

  it('carries design extraction metadata on the packet when a design-system template is used', async () => {
    const body = '# Brand Guide\n\nPrimary: #1122FF. Surface: #fafafa. Font: "DM Sans", sans-serif. Card radius: 14px.';
    const result = await ingestAutomationSource(dataDir, {
      templateId: 'extract-design-system',
      sourceKind: 'url',
      sourceRef: 'https://acme.com/brand',
      title: 'Acme brand guide',
      bodyMarkdown: body,
      tokenCompression: 'off',
    });

  const packet = await getAutomationSourcePacket(dataDir, result.packet.id);
  expect(packet).toBeDefined();
  const meta = packet!.metadata as Record<string, unknown> | undefined;
  const rawExtraction = (meta?.designExtraction ?? {}) as Record<string, unknown>;
  expect(typeof rawExtraction.signalCount).toBe('number');
  expect(Number(rawExtraction.signalCount)).toBeGreaterThan(0);
  expect(Array.isArray(rawExtraction.signalKinds)).toBe(true);
  expect((rawExtraction.signalKinds as string[]).length).toBeGreaterThan(0);
  });

  it('attaches prior-proposal lineage when a second design-system ingestion shares the same slug', async () => {
    const v1Slug = 'acme-shared-brand';
    const first = await ingestAutomationSource(dataDir, {
      templateId: 'extract-design-system',
      sourceKind: 'upload',
      sourceRef: 'brand-spec-v1.pdf',
      title: 'Acme shared brand',
      bodyMarkdown: 'Primary #1122FF. Inter display.',
      tokenCompression: 'off',
    });
    const firstDesignProposals = (await listAutomationProposals(dataDir, { status: 'all' }))
      .filter((p) => p.sourcePacketIds.includes(first.packet.id) && p.targetKind === 'design-system');
    await Promise.all(firstDesignProposals.map((p) => applyAutomationProposal(dataDir, p.id)));

    const second = await ingestAutomationSource(dataDir, {
      templateId: 'extract-design-system',
      sourceKind: 'url',
      sourceRef: 'https://acme.com/brand-v2',
      title: 'Acme shared brand',
      bodyMarkdown: 'Primary #1122FF. Updated surface #ffffff.',
      tokenCompression: 'off',
    });

  const designProposal = second.proposals.find((p) => p.targetKind === 'design-system');
  expect(designProposal).toBeDefined();
  const meta = designProposal!.metadata as Record<string, JsonValue> | undefined;
  expect(meta?.priorProposalId).toBeDefined();
  expect(typeof meta?.priorProposalId).toBe('string');
  if (typeof meta?.priorProposalId === 'string') {
    expect(meta.priorProposalId.length).toBeGreaterThan(0);
  }
  expect(meta?.slug).toBe('acme-shared-brand');
  });

  it('design-system proposal metadata carries extracted signal summary for lineage', async () => {
    const body = '# Neutral Modern\n\nCobalt #2f6feb. Inter. 12px.';
    const result = await ingestAutomationSource(dataDir, {
      templateId: 'extract-design-system',
      sourceKind: 'repo',
      sourceRef: 'https://github.com/acme/design',
      title: 'Neutral Modern',
      bodyMarkdown: body,
      tokenCompression: 'off',
    });

    const designProposal = result.proposals.find((p) => p.targetKind === 'design-system');
    expect(designProposal).toBeDefined();
    expect(designProposal!.metadata).toBeDefined();
    const meta = designProposal!.metadata as Record<string, unknown>;
    expect(typeof meta.extractedSignalsCount).toBe('number');
    expect(meta.extractedSignalsCount).toBeGreaterThan(0);
    expect(Array.isArray(meta.signalKinds)).toBe(true);
    expect(meta.slug).toBe('neutral-modern');
  });

  it('listAutomationSourcePacketsForSlug returns packets matching a design-system targetRef', async () => {
    const slug = 'acme-starter-brand';
    await ingestAutomationSource(dataDir, {
      templateId: 'extract-design-system',
      sourceKind: 'url',
      sourceRef: 'https://acme.com/brand',
      title: 'Acme starter brand',
      bodyMarkdown: 'Primary #1122FF.',
      tokenCompression: 'off',
      metadata: { targetRef: `design-systems/${slug}/DESIGN.md` },
    });

    const matches = await listAutomationSourcePacketsForSlug(dataDir, slug);
    expect(matches.length).toBeGreaterThanOrEqual(1);
    expect(matches[0]!.metadata).toBeDefined();
  });

  it('extracts structured signals from design source and produces a draft with all token sections', () => {
    const body = `
      :root {
        --bg: #fafafa;
        --surface: #ffffff;
        --fg: #111111;
        --muted: #6b6b6b;
        --border: #e5e5e5;
        --accent: #2f6feb;
        --font-display: "Inter", system-ui, sans-serif;
        --font-body: "Inter", system-ui, sans-serif;
        --font-mono: "JetBrains Mono", monospace;
        --space-1: 4px;
        --space-2: 8px;
        --space-4: 16px;
        --space-6: 24px;
        --radius-sm: 8px;
        --radius-md: 12px;
        --motion-fast: 150ms;
        --motion-base: 200ms;
      }
      .btn { border-radius: 8px; transition: background 150ms ease; }
      .card { box-shadow: 0 2px 8px rgba(0,0,0,0.08); }
      h1 { font-family: "Inter", system-ui, sans-serif; font-size: 48px; letter-spacing: -0.01em; }
      .sidebar { display: flex; }
    `;

    const signals = extractDesignSignals(body);
    expect(signals.length).toBeGreaterThan(0);

    const kinds = new Set(signals.map((s) => s.kind));
    expect(kinds.has('color')).toBe(true);
    expect(kinds.has('font')).toBe(true);
    expect(kinds.has('spacing')).toBe(true);
    expect(kinds.has('radius')).toBe(true);
    expect(kinds.has('motion')).toBe(true);
    expect(kinds.has('component')).toBe(true);
    expect(kinds.has('layout')).toBe(true);
    expect(kinds.has('typography-scale')).toBe(true);

    const pkg = buildDesignExtractionPackage(body, 'Test DS');
    expect(Object.keys(pkg.draft.colorTokens).length).toBeGreaterThan(0);
    expect(Object.keys(pkg.draft.fontTokens).length).toBeGreaterThan(0);
    expect(Object.keys(pkg.draft.spacingTokens).length).toBeGreaterThan(0);
    expect(Object.keys(pkg.draft.radiusTokens).length).toBeGreaterThan(0);
    expect(Object.keys(pkg.draft.motionTokens).length).toBeGreaterThan(0);
    expect(pkg.draft.reviewerPrompts.length).toBeGreaterThan(0);
    expect(pkg.draft.layoutPosture.length).toBeGreaterThan(0);
    expect(pkg.draft.components.length).toBeGreaterThan(0);
  });
});
