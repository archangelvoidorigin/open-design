import { describe, expect, it } from 'vitest';

import { buildDesignExtractionPackage, extractDesignSignals, mergeSignalsByValue } from '../src/automation-design-extraction.js';

describe('automation design extraction', () => {
  const cssBody = `
    :root {
      --bg: #fafafa;
      --surface: #ffffff;
      --fg: #111111;
      --muted: #6b6b6b;
      --border: #e5e5e5;
      --accent: #2f6feb;
      --font-display: "Inter", -apple-system, system-ui, sans-serif;
      --font-body: "Inter", -apple-system, system-ui, sans-serif;
      --font-mono: "JetBrains Mono", ui-monospace, monospace;
      --space-1: 4px;
      --space-2: 8px;
      --space-4: 16px;
      --space-6: 24px;
      --radius-sm: 8px;
      --radius-md: 12px;
      --motion-fast: 150ms;
      --motion-base: 200ms;
    }
    h1 { font-family: "Iowan Old Style", Georgia, serif; font-size: 64px; letter-spacing: -0.01em; }
    .btn { border-radius: 8px; transition: background 150ms ease; }
    .card { box-shadow: 0 2px 8px rgba(0,0,0,0.08); }
    .sidebar { display: flex; }
  `;

  it('extracts hex colors with confidence', () => {
    const signals = extractDesignSignals(cssBody);
    const colorSignals = signals.filter((s) => s.kind === 'color');
    expect(colorSignals.length).toBeGreaterThanOrEqual(6);
    const accent = colorSignals.find((s) => s.value === '#2f6feb');
    expect(accent).toBeDefined();
    expect(accent!.confidence).toBe('high');
  });

  it('extracts font families from custom property and font-family declarations', () => {
    const signals = extractDesignSignals(cssBody);
    const fontSignals = signals.filter((s) => s.kind === 'font');
    const hasInter = fontSignals.some((s) => s.value.toLowerCase().includes('inter'));
    const hasIowan = fontSignals.some((s) => s.value.toLowerCase().includes('iowan'));
    expect(hasInter || hasIowan).toBe(true);
  });

  it('extracts spacing and radius from custom property declarations', () => {
    const signals = extractDesignSignals(cssBody);
    const spacing = signals.filter((s) => s.kind === 'spacing').map((s) => s.value);
    const radii = signals.filter((s) => s.kind === 'radius').map((s) => s.value);
    expect(spacing.some((v) => v === '4px')).toBe(true);
    expect(spacing.some((v) => v === '8px')).toBe(true);
    expect(radii.some((v) => v === '8px')).toBe(true);
  });

  it('detects component keywords from class names and depth tokens from box-shadow', () => {
    const signals = extractDesignSignals(cssBody);
    const components = signals.filter((s) => s.kind === 'component').map((s) => s.value);
    expect(components.length).toBeGreaterThanOrEqual(1);
    expect(components).toContain('card');
    const depth = signals.filter((s) => s.kind === 'depth');
    expect(depth.length).toBeGreaterThanOrEqual(1);
  });

  it('deduplicates merged signals by value', () => {
    const bodyWithDuplicates = '#335cff primary action. #335CFF also primary. Inter for display. Inter for body.';
    const signals = extractDesignSignals(bodyWithDuplicates);
    const merged = mergeSignalsByValue(signals);
    const accent = merged.find((m) => m.kind === 'color');
    expect(accent).toBeDefined();
    expect(accent!.occurrences).toBeGreaterThanOrEqual(2);
    const fontSignal = merged.find((m) => m.kind === 'font' && m.value.toLowerCase() === 'inter');
    expect(fontSignal).toBeDefined();
    expect(fontSignal!.occurrences).toBeGreaterThanOrEqual(2);
  });

  it('builds a normalised design system draft with reviewer prompts', () => {
    const result = buildDesignExtractionPackage(cssBody, 'Test Brand');
    expect(result.draft.category).toBe('Self-evolved');
    expect(Object.keys(result.draft.colorTokens).length).toBeGreaterThanOrEqual(1);
    expect(Object.keys(result.draft.fontTokens).length).toBeGreaterThanOrEqual(1);
    expect(result.draft.reviewerPrompts.length).toBeGreaterThanOrEqual(1);
    expect(result.merged.length).toBeGreaterThan(0);
  });

  it('flags low confidence for short hex values', () => {
    const shortHexBody = 'Use #2f6feb as accent and #fff for surface and #333 for text.';
    const result = buildDesignExtractionPackage(shortHexBody, 'Short Hex');
    const lowConfidence = result.signals.filter((s) => s.confidence === 'low');
    expect(lowConfidence.length).toBeGreaterThanOrEqual(2);
  });

  it('produces reviewer prompts when font signals are absent', () => {
    const minimalBody = 'Brand color #c0ffee. Background #f0f0f0.';
    const result = buildDesignExtractionPackage(minimalBody, 'Minimal');
    expect(result.extractionWarnings.some((w) => /font/i.test(w))).toBe(true);
  });

  it('extracts motion and layout posture from design source', () => {
    const body = `
      :root {
        --motion-fast: 150ms;
        --motion-base: 200ms;
        --transition-hover: all 250ms ease;
      }
      .dashboard { display: grid; grid-template-columns: 240px 1fr; }
      .sidebar { display: flex; }
    `;
    const signals = extractDesignSignals(body);
    const motion = signals.filter((s) => s.kind === 'motion');
    expect(motion.length).toBeGreaterThanOrEqual(1);
    const layout = signals.filter((s) => s.kind === 'layout');
    expect(layout.length).toBeGreaterThanOrEqual(1);
  });

  it('produces a full token draft including radius, motion, depth, components, and posture', () => {
    const body = `
      :root {
        --radius-sm: 8px; --radius-md: 12px;
        --motion-fast: 150ms;
        --motion-base: 200ms;
        --transition-hover: background 150ms ease;
      }
      .btn { border-radius: 8px; transition: background 150ms ease; }
      .card { box-shadow: 0 2px 8px rgba(0,0,0,0.08); }
    `;
    const pkg = buildDesignExtractionPackage(body, 'Full Token Test');
    expect(Object.keys(pkg.draft.colorTokens).length).toBeGreaterThanOrEqual(0);
    expect(Object.keys(pkg.draft.fontTokens).length).toBeGreaterThanOrEqual(0);
    expect(Object.keys(pkg.draft.spacingTokens).length).toBeGreaterThanOrEqual(0);
    expect(Object.keys(pkg.draft.radiusTokens).length).toBeGreaterThanOrEqual(1);
    expect(Object.keys(pkg.draft.motionTokens).length).toBeGreaterThanOrEqual(1);
    expect(pkg.draft.reviewerPrompts.length).toBeGreaterThan(0);
    expect(pkg.draft.layoutPosture.length).toBeGreaterThan(0);
    expect(pkg.draft.components.length).toBeGreaterThan(0);
    expect(pkg.draft.depthModel.length).toBeGreaterThan(0);
  });
});
