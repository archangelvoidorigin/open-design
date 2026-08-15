import type { JsonValue } from '@open-design/contracts';

export interface DesignSignal {
  kind: 'color' | 'font' | 'spacing' | 'motion' | 'component' | 'layout' | 'radius' | 'depth' | 'typography-scale';
  value: string;
  confidence: 'high' | 'medium' | 'low';
  context: string;
  sourceSpan: { start: number; end: number } | undefined;
}

function signal(kind: DesignSignal['kind'], value: string, confidence: DesignSignal['confidence'], context: string, sourceSpan: { start: number; end: number } | undefined): DesignSignal {
  return { kind, value, confidence, context, sourceSpan };
}

export interface MergedSignal {
  kind: DesignSignal['kind'];
  value: string;
  confidence: 'high' | 'medium' | 'low';
  occurrences: number;
  contexts: string[];
}

function normaliseColor(hex: string): string {
  return hex.toLowerCase().replace(/^#/, '');
}

function normaliseFont(family: string): string {
  return family
    .toLowerCase()
    .replace(/['"]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normaliseSpacing(token: string): string {
  return token.toLowerCase().replace(/\s+/g, ' ').trim();
}

const DEDUP_NORMALISERS: Record<DesignSignal['kind'], (value: string) => string> = {
  color: normaliseColor,
  font: normaliseFont,
  spacing: normaliseSpacing,
  motion: (v) => v.toLowerCase(),
  component: (v) => v.toLowerCase(),
  layout: (v) => v.toLowerCase(),
  radius: (v) => v.toLowerCase(),
  depth: (v) => v.toLowerCase(),
  'typography-scale': (v) => v.toLowerCase(),
};

const HEX_RE = /#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/g;
const FONT_FAMILY_RE = /font-family\s*:\s*([^;}\n]+)/gi;
const FONT_VAR_RE = /--(?:font|font-display|font-body|font-mono)[-\w]*\s*[=:]\s*([^;}\n]+)/gi;
const FONT_ROLE_RE = /\b([A-Z][A-Za-z0-9]*(?:\s+[A-Z][A-Za-z0-9]*){0,3})\s+for\s+(?:display|body|mono|headings?|copy)\b/g;
const FONT_WEIGHT_RE = /font-weight\s*:\s*(\d{3})/gi;
const FONT_SIZE_RE = /font-size\s*:\s*(\d+(?:\.\d+)?)(px|rem|em)/gi;
const LETTER_SPACING_RE = /letter-spacing\s*:\s*([-\d.]+(?:px|em|rem)?)/gi;
const SPACING_RE = /(?:--space|spacing|gap|padding|margin)[\w-]*\s*[:=]\s*(\d+(?:\.\d+)?)(px|rem|em)?/gi;
const RADIUS_RE = /(?:border-radius|--radius)[-\w]*\s*[=:]\s*(\d+)(px|rem|em)?/gi;
const SHADOW_RE = /box-shadow\s*:\s*([^;}\n]+)/gi;
const TRANSITION_RE = /transition\s*:\s*([^;}\n]+)/gi;
const MOTION_VAR_RE = /--(?:motion|transition)[-\w]*\s*[=:]\s*([^;}\n]+)/gi;
const COMPONENT_HINTS = /\b(?:button|card|input|badge|chip|table|grid|nav|sidebar|modal|drawer|dropdown|tab|tabs|avatar|toolbar|menu|sheet)\b/gi;

const MAX_WIDTH_RE = /(?:max-width|maxWidth|container)\s*[:=]\s*(\d+)(px|rem|em)?/gi;
const GRID_TEMPLATE_COLUMNS_RE = /grid-template-columns\s*[:=]\s*([^;}\n]+)/gi;

export function extractDesignSignals(body: string): DesignSignal[] {
  function spanFor(bodyStr: string, index: number): { start: number; end: number } | undefined {
    const lineStart = bodyStr.lastIndexOf('\n', index) + 1;
    const lineEnd = bodyStr.indexOf('\n', index);
    return { start: lineStart, end: lineEnd === -1 ? bodyStr.length : lineEnd };
  }

  const signals: DesignSignal[] = [];

  function push(s: DesignSignal): void {
    signals.push(s);
  }

  let hexMatch: RegExpExecArray | null;
  while ((hexMatch = HEX_RE.exec(body)) !== null) {
    const raw = (hexMatch[1] ?? hexMatch[0] ?? '').trim();
    if (!raw.startsWith('#')) continue;
    const slice = raw.length > 1 ? raw.slice(1) : raw;
    const confidence: DesignSignal['confidence'] =
      raw.length <= 4 ? 'low' : raw.length === 5 ? 'low' : 'high';
    push(signal('color', raw, confidence,
      body.slice(Math.max(0, hexMatch.index - 60), hexMatch.index + raw.length + 30).replace(/\s+/g, ' ').trim(),
      spanFor(body, hexMatch.index)));
  }

  let fontMatch: RegExpExecArray | null;
  while ((fontMatch = FONT_FAMILY_RE.exec(body)) !== null) {
    const raw = (fontMatch[1] ?? '').trim();
    if (raw.length < 3) continue;
    const families = raw
      .split(',')
      .map((f: string) => f.replace(/['"]/g, '').trim())
      .filter((f: string) => f.length > 0);
    const ctx = `font-family: ${raw}`;
    for (const family of families) {
      if (family.length < 3) continue;
      push(signal('font', family, 'high', ctx, spanFor(body, fontMatch.index)));
    }
  }

  let fontVarMatch: RegExpExecArray | null;
  while ((fontVarMatch = FONT_VAR_RE.exec(body)) !== null) {
    const raw = (fontVarMatch[1] ?? '').trim();
    if (raw.length < 3) continue;
    const families = raw
      .split(',')
      .map((family) => family.replace(/["']/g, '').trim())
      .filter((family) => family.length >= 3);
    for (const family of families) {
      push(signal('font', family, 'high', fontVarMatch[0], spanFor(body, fontVarMatch.index)));
    }
  }

  let fontRoleMatch: RegExpExecArray | null;
  while ((fontRoleMatch = FONT_ROLE_RE.exec(body)) !== null) {
    const family = (fontRoleMatch[1] ?? '').trim();
    if (family.length < 3) continue;
    push(signal('font', family, 'medium', fontRoleMatch[0], spanFor(body, fontRoleMatch.index)));
  }

  let weightMatch: RegExpExecArray | null;
  while ((weightMatch = FONT_WEIGHT_RE.exec(body)) !== null) {
    const val = weightMatch[1] ?? '400';
    push(signal('typography-scale', `font-weight:${val}`, 'medium', 'font-weight declaration', spanFor(body, weightMatch.index)));
  }

  let sizeMatch: RegExpExecArray | null;
  while ((sizeMatch = FONT_SIZE_RE.exec(body)) !== null) {
    const num = sizeMatch[1] ?? '16';
    const unit = sizeMatch[2] ?? 'px';
    push(signal('typography-scale', `font-size:${num}${unit}`, 'medium', 'font-size declaration', spanFor(body, sizeMatch.index)));
  }

  let lsMatch: RegExpExecArray | null;
  while ((lsMatch = LETTER_SPACING_RE.exec(body)) !== null) {
    const val = lsMatch[1] ?? '0';
    push(signal('typography-scale', `letter-spacing:${val}`, 'medium', 'letter-spacing declaration', spanFor(body, lsMatch.index)));
  }

  const FONT_RE = /font\s*:\s*([^;\n}]+)/gi;
  let compoundFont: RegExpExecArray | null;
  while ((compoundFont = FONT_RE.exec(body)) !== null) {
    const raw = (compoundFont[1] ?? '').trim();
    if (!raw) continue;
    push(signal('font', raw.slice(0, 120), 'medium', raw, spanFor(body, compoundFont.index)));
  }

  const COMPONENT_KEYWORDS: ReadonlyArray<{ keyword: string; kind: DesignSignal['kind']; value: string }> = [
    { keyword: 'button', kind: 'component', value: 'button' },
    { keyword: 'card', kind: 'component', value: 'card' },
    { keyword: 'input', kind: 'component', value: 'input' },
    { keyword: 'badge', kind: 'component', value: 'badge' },
    { keyword: 'chip', kind: 'component', value: 'chip' },
    { keyword: 'modal', kind: 'component', value: 'modal' },
    { keyword: 'drawer', kind: 'component', value: 'drawer' },
    { keyword: 'dropdown', kind: 'component', value: 'dropdown' },
    { keyword: 'tab', kind: 'component', value: 'tab' },
    { keyword: 'tabs', kind: 'component', value: 'tab' },
    { keyword: 'table', kind: 'component', value: 'table' },
    { keyword: 'grid', kind: 'component', value: 'grid' },
    { keyword: 'sidebar', kind: 'component', value: 'sidebar' },
    { keyword: 'navbar', kind: 'component', value: 'navbar' },
    { keyword: 'nav bar', kind: 'component', value: 'navbar' },
    { keyword: 'toolbar', kind: 'component', value: 'toolbar' },
    { keyword: 'avatar', kind: 'component', value: 'avatar' },
  ];

  COMPONENT_HINTS.lastIndex = 0;
  let keywordMatch: RegExpExecArray | null;
  while ((keywordMatch = COMPONENT_HINTS.exec(body)) !== null) {
    const kw = keywordMatch[0].toLowerCase();
    const entry = COMPONENT_KEYWORDS.find((c: { keyword: string }) => c.keyword === kw);
    if (entry) {
      const ctx = body.slice(Math.max(0, keywordMatch.index - 40), keywordMatch.index + keywordMatch[0].length + 40).replace(/\s+/g, ' ').trim();
      push(signal(entry.kind, entry.value, body.length < 6000 ? 'high' : 'medium', ctx, spanFor(body, keywordMatch.index)));
    }
  }

  let spacingMatch: RegExpExecArray | null;
  while ((spacingMatch = SPACING_RE.exec(body)) !== null) {
    const num = spacingMatch[1] ?? '0';
    const unit = spacingMatch[2] ?? '';
    const raw = `${num}${unit}`;
    if (/^\d+$/.test(raw) && Number(raw) > 20) continue;
    const ctx = body.slice(Math.max(0, spacingMatch.index - 20), spacingMatch.index + spacingMatch[0].length + 30).replace(/\s+/g, ' ').trim();
    push(signal('spacing', raw, 'high', ctx, spanFor(body, spacingMatch.index)));
  }

  let radiusMatch: RegExpExecArray | null;
  while ((radiusMatch = RADIUS_RE.exec(body)) !== null) {
    const num = radiusMatch[1] ?? '0';
    const unit = radiusMatch[2] ?? 'px';
    const raw = `${num}${unit}`;
    const ctx = body.slice(Math.max(0, radiusMatch.index - 20), radiusMatch.index + radiusMatch[0].length + 30).replace(/\s+/g, ' ').trim();
    push(signal('radius', raw, 'high', ctx, spanFor(body, radiusMatch.index)));
  }

  let shadowMatch: RegExpExecArray | null;
  while ((shadowMatch = SHADOW_RE.exec(body)) !== null) {
    const val = (shadowMatch[1] ?? '').trim().slice(0, 100);
    if (!val) continue;
    if (/rgba\s*\([^)]*\)/.test(val) || /transparent/.test(val)) {
      push(signal('depth', `shadow:${val}`, 'high', 'box-shadow declaration', spanFor(body, shadowMatch.index)));
    }
  }

  let transMatch: RegExpExecArray | null;
  while ((transMatch = TRANSITION_RE.exec(body)) !== null) {
    const val = (transMatch[1] ?? '').trim().slice(0, 80);
    if (!val) continue;
    push(signal('motion', `transition:${val}`, 'medium', 'transition declaration', spanFor(body, transMatch.index)));
  }

  let motionVarMatch: RegExpExecArray | null;
  while ((motionVarMatch = MOTION_VAR_RE.exec(body)) !== null) {
    const val = (motionVarMatch[1] ?? '').trim().slice(0, 80);
    if (!val) continue;
    push(signal('motion', `${motionVarMatch[0].split(/[:=]/, 1)[0]!.trim()}:${val}`, 'high', motionVarMatch[0], spanFor(body, motionVarMatch.index)));
  }

  const SPECIAL_DEPTH: ReadonlyArray<{ keyword: string; value: string }> = [
    { keyword: 'glassmorphism', value: 'glassmorphism' },
    { keyword: 'neumorphism', value: 'neumorphism' },
    { keyword: 'flat design', value: 'flat' },
    { keyword: 'elevation', value: 'elevation-based' },
    { keyword: 'no shadow', value: 'flat-no-shadow' },
    { keyword: 'no shadows', value: 'flat-no-shadow' },
  ];
  const lowered = body.toLowerCase();
  for (const entry of SPECIAL_DEPTH) {
    if (lowered.includes(entry.keyword)) {
      push(signal('depth', entry.value, 'high', `keyword: ${entry.keyword}`, undefined));
    }
  }

  const LAYOUT_KEYWORDS = [
    '12-column grid',
    '8-column grid',
    '4-column grid',
    'container queries',
    'fluid type',
    'clamp(',
    'fixed canvas',
    'scale-to-fit',
    'sidebar',
    'split pane',
  ];
  for (const kw of LAYOUT_KEYWORDS) {
    if (lowered.includes(kw.toLowerCase())) {
      push(signal('layout', kw, 'high', `keyword: ${kw}`, undefined));
    }
  }

  let maxWidthMatch: RegExpExecArray | null;
  while ((maxWidthMatch = MAX_WIDTH_RE.exec(body)) !== null) {
    const value = `${maxWidthMatch[1] ?? ''}${maxWidthMatch[2] ?? ''}`;
    if (!value) continue;
    push(signal('layout', `max-width:${value}`, 'high', maxWidthMatch[0], spanFor(body, maxWidthMatch.index)));
  }

  let columnsMatch: RegExpExecArray | null;
  while ((columnsMatch = GRID_TEMPLATE_COLUMNS_RE.exec(body)) !== null) {
    const value = (columnsMatch[1] ?? '').trim().slice(0, 100);
    if (!value) continue;
    push(signal('layout', `grid-template-columns:${value}`, 'high', columnsMatch[0], spanFor(body, columnsMatch.index)));
  }

  return signals;
}

export function mergeSignalsByValue(signals: DesignSignal[]): MergedSignal[] {
  const buckets = new Map<string, MergedSignal>();
  for (const s of signals) {
    const key = `${s.kind}:${DEDUP_NORMALISERS[s.kind](s.value)}`;
    const existing = buckets.get(key);
    if (existing) {
      existing.occurrences += 1;
      existing.contexts.push(s.context);
      if (existing.confidence === 'low' || s.confidence === 'high') {
        existing.confidence = s.confidence;
      }
      existing.value = existing.value ?? s.value;
    } else {
      buckets.set(key, { kind: s.kind, value: s.value, confidence: s.confidence, occurrences: 1, contexts: [s.context] });
    }
  }
  return [...buckets.values()].sort((a, b) => b.occurrences - a.occurrences);
}

export interface NormalizedDesignSystemDraft {
  category: string;
  surface: string;
  colorTokens: Record<string, string>;
  fontTokens: Record<string, string>;
  spacingTokens: Record<string, string>;
  radiusTokens: Record<string, string>;
  motionTokens: Record<string, string>;
  depthModel: string;
  components: string[];
  layoutPosture: string[];
  signals: DesignSignal[];
  mergedSignals: MergedSignal[];
  reviewerPrompts: string[];
  evolutionNotes: string;
}

export function normalizeSignalsToDraft(signals: DesignSignal[], sourceTitle: string): NormalizedDesignSystemDraft {
  const merged = mergeSignalsByValue(signals);
  const colorTokens: Record<string, string> = {};
  const fontTokens: Record<string, string> = {};
  const spacingTokens: Record<string, string> = {};
  const radiusTokens: Record<string, string> = {};
  const motionTokens: Record<string, string> = {};
  const components: string[] = [];
  const layoutPosture: string[] = [];

  for (const s of merged) {
    switch (s.kind) {
      case 'color':
        if (s.value.startsWith('#')) {
          const primarySlot = colorTokens['--primary'] ?? colorTokens['--accent'];
          if (!primarySlot) colorTokens['--primary'] = s.value;
        }
        break;
      case 'font': {
        const isMono = /mono|code|console|courier/i.test(s.value);
        fontTokens[isMono ? '--font-mono' : '--font-display'] = s.value;
        break;
      }
      case 'spacing':
        spacingTokens[`--space-${Object.keys(spacingTokens).length + 1}`] = s.value;
        break;
      case 'radius':
        radiusTokens[`--radius-${Object.keys(radiusTokens).length + 1}`] = s.value;
        break;
      case 'motion': {
        const idx = Object.keys(motionTokens).length + 1;
        motionTokens[`--motion-${idx}`] = s.value;
        break;
      }
      case 'depth':
        layoutPosture.push(`Depth model: ${s.value}`);
        break;
      case 'component':
        if (!components.includes(s.value)) components.push(s.value);
        break;
      case 'layout':
        layoutPosture.push(s.value);
        break;
      case 'typography-scale':
        break;
    }
  }

  const expansionGuidance = `Draft a tokens.css for ${sourceTitle} using these extracted primitives. Resolve semantic roles from context (bg / surface / fg / muted / border / accent). Untyped values are design decisions for the reviewer, not gaps to fill with defaults.`;

  const reviewerPrompts: string[] = [];
  if (!colorTokens['--accent'] && !colorTokens['--primary']) {
    reviewerPrompts.push('No explicit secondary or accent color found — reviewer must choose a functional accent.');
  }
  if (Object.keys(fontTokens).length < 2) {
    reviewerPrompts.push('Font signal was thin — confirm display and body face.');
  }
  if (Object.keys(spacingTokens).length < 3) {
    reviewerPrompts.push('Spacing scale underspecified — define a base unit (4px or 8px) and derive tokens.');
  }
  if (Object.keys(radiusTokens).length === 0) {
    reviewerPrompts.push("No radius tokens found — state the brand's radius posture (sharp / small / medium / pill).");
  }
  if (components.length === 0) {
    reviewerPrompts.push('No component keywords detected — reviewer should confirm required primitives (card, button, input, nav).');
  }
  if (reviewerPrompts.length === 0) {
    reviewerPrompts.push('Signal coverage is broad — validate that typography scale, semantic colors, and motion tokens are complete.');
  }

  return {
    category: 'Self-evolved',
    surface: 'web',
    colorTokens,
    fontTokens,
    spacingTokens,
    radiusTokens,
    motionTokens,
    depthModel: layoutPosture.find((p) => p.startsWith('Depth model:'))?.replace('Depth model: ', '') ?? 'flat',
    components,
    layoutPosture: [...new Set(layoutPosture)],
    signals,
    mergedSignals: merged,
    reviewerPrompts,
    evolutionNotes: expansionGuidance,
  };
}

export interface DesignExtractionPackage {
  signals: DesignSignal[];
  merged: MergedSignal[];
  draft: NormalizedDesignSystemDraft;
  extractionWarnings: string[];
}

export function buildDesignExtractionPackage(body: string, sourceTitle: string): DesignExtractionPackage {
  const signals = extractDesignSignals(body);
  const merged = mergeSignalsByValue(signals);
  const draft = normalizeSignalsToDraft(signals, sourceTitle);

  const extractionWarnings: string[] = [];
  const colorConfidence = merged
    .filter((m) => m.kind === 'color')
    .every((m) => m.confidence === 'high')
    ? []
    : ['Some colors were inferred from short hex values (3–4 digit) — validate before promoting.'];

  if (signals.length < 5) {
    extractionWarnings.push('Signal count is low — the source may not contain enough design artefact text. Consider attaching CSS, a brand-guide PDF, or a screenshot.');
  }
  if (merged.filter((m) => m.kind === 'font').length === 0) {
    extractionWarnings.push('No font families detected — reviewer must confirm or supply --font-display / --font-body.');
  }

  return { signals, merged, draft, extractionWarnings: [...extractionWarnings, ...colorConfidence] };
}
