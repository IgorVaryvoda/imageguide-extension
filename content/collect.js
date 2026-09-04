/**
 * The page collector.
 *
 * Chrome serialises `collectImages` with `toString()`, so every helper must
 * stay inside the function and every shared value arrives as an argument.
 */
export function collectImages(
  markAttribute,
  previousMarkAttribute,
  maxElements,
  maxResources,
  maxUsages,
  maxUrlLength,
  maxSerializedUrlChars,
  maxSerializedPayloadBytes,
  timingBufferSize,
  maxScanDurationMs,
  watchKey
) {
  const scanStart = typeof performance.now === 'function' ? performance.now() : Date.now();
  const now = () => (typeof performance.now === 'function' ? performance.now() : Date.now());
  const dpr = window.devicePixelRatio || 1;
  const viewportHeight = window.innerHeight;
  const viewportWidth = window.innerWidth;
  const isSpace = (character) => /[\t\n\f\r ]/.test(character || '');

  const absolute = (url) => {
    if (!url) return '';
    try {
      return new URL(url, document.baseURI).href;
    } catch {
      return '';
    }
  };

  /** Tokenise srcset without treating data-URL commas as separators. */
  const parseSrcset = (input) => {
    const candidates = [];
    let position = 0;

    while (position < input.length) {
      while (position < input.length && (isSpace(input[position]) || input[position] === ',')) {
        position += 1;
      }
      if (position >= input.length) break;

      let url = '';
      while (position < input.length && !isSpace(input[position])) {
        url += input[position];
        position += 1;
      }

      const descriptors = [];
      if (url.endsWith(',')) {
        url = url.replace(/,+$/, '');
      } else {
        while (position < input.length && isSpace(input[position])) position += 1;
        let descriptor = '';
        let state = 'descriptor';

        while (position <= input.length) {
          const character = position < input.length ? input[position] : '';
          if (state === 'descriptor') {
            if (!character || character === ',') {
              if (descriptor) descriptors.push(descriptor);
              if (character === ',') position += 1;
              break;
            }
            if (isSpace(character)) {
              if (descriptor) descriptors.push(descriptor);
              descriptor = '';
              state = 'after';
            } else {
              descriptor += character;
              if (character === '(') state = 'parens';
            }
          } else if (state === 'parens') {
            descriptor += character;
            if (!character || character === ')') state = 'descriptor';
            if (!character) {
              descriptors.push(descriptor);
              break;
            }
          } else if (!character) {
            break;
          } else if (!isSpace(character)) {
            state = 'descriptor';
            position -= 1;
          }
          position += 1;
        }
      }

      let width = 0;
      let density = 0;
      let invalid = !url;
      for (const descriptor of descriptors) {
        if (/^[0-9]+w$/.test(descriptor) && !width && !density) {
          width = Number.parseInt(descriptor, 10);
          if (width <= 0) invalid = true;
        } else if (
          /^[+]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?x$/.test(descriptor) &&
          !width &&
          !density
        ) {
          density = Number.parseFloat(descriptor);
          if (!(density > 0)) invalid = true;
        } else {
          invalid = true;
        }
      }

      if (!invalid) {
        candidates.push({
          url,
          width,
          density: width ? 0 : density || 1,
          intrinsic: false,
          descriptor: width ? `${width}w` : `${density || 1}x`
        });
      }
    }

    return candidates;
  };

  const candidatesOf = (element) =>
    parseSrcset(element.getAttribute('srcset') || '').map((candidate) => ({
      ...candidate,
      url: absolute(candidate.url)
    }));

  const mediaMatches = (source) => {
    const media = source.getAttribute('media') || '';
    if (!media || typeof window.matchMedia !== 'function') return true;
    try {
      return window.matchMedia(media).matches;
    } catch {
      return false;
    }
  };

  /** Match currentSrc exactly; disagreement between plausible owners stays unknown. */
  const selectedSource = (element, currentUrl, sources) => {
    const groups = [];
    for (const source of sources) {
      if (!mediaMatches(source)) continue;
      const candidates = candidatesOf(source);
      const matches = candidates.filter((candidate) => candidate.url === currentUrl);
      if (matches.length) groups.push({ owner: source, candidates, matches });
    }

    const ownCandidates = candidatesOf(element);
    const ownMatches = ownCandidates.filter((candidate) => candidate.url === currentUrl);
    if (ownMatches.length) groups.push({ owner: element, candidates: ownCandidates, matches: ownMatches });

    const fallback = absolute(element.getAttribute('src') || '');
    if (fallback && fallback === currentUrl && !ownMatches.length) {
      groups.push({
        owner: element,
        candidates: [{
          url: fallback,
          width: 0,
          density: 1,
          intrinsic: true,
          descriptor: ''
        }],
        matches: [{
          url: fallback,
          width: 0,
          density: 1,
          intrinsic: true,
          descriptor: ''
        }]
      });
    }

    if (!groups.length) return { owner: element, candidates: ownCandidates, matches: [] };
    if (groups.length === 1) return groups[0];
    return {
      owner: null,
      candidates: groups.flatMap((group) => group.candidates),
      matches: groups.flatMap((group) => group.matches)
    };
  };

  const candidateDimensions = (selection, naturalWidth, naturalHeight) => {
    if (!selection.matches.length || !(naturalWidth > 0) || !(naturalHeight > 0)) {
      return { width: 0, height: 0, confidence: 'unknown', descriptor: '' };
    }

    const dimensions = selection.matches.map((candidate) => {
      if (candidate.intrinsic) {
        return {
          width: naturalWidth,
          height: naturalHeight,
          confidence: 'intrinsic',
          descriptor: ''
        };
      }
      const scale = candidate.width ? candidate.width / naturalWidth : candidate.density;
      return {
        width: candidate.width || Math.round(naturalWidth * scale),
        height: Math.round(naturalHeight * scale),
        confidence: 'descriptor',
        descriptor: candidate.descriptor
      };
    });
    const first = dimensions[0];
    const agrees = dimensions.every(
      (candidate) => candidate.width === first.width && candidate.height === first.height
    );
    return agrees
      ? {
          ...first,
          descriptor: dimensions.every((candidate) => candidate.descriptor === first.descriptor)
            ? first.descriptor
            : ''
        }
      : { width: 0, height: 0, confidence: 'unknown', descriptor: '' };
  };

  const resourceEntries = performance.getEntriesByType('resource');
  const timingBufferFull = resourceEntries.length >= timingBufferSize;
  const timingNames = new Set(resourceEntries.map((entry) => entry.name));
  const timings = new Map();
  for (const entry of resourceEntries) {
    const encodedBytes = Number(entry.encodedBodySize) || 0;
    const transferBytes = Number(entry.transferSize) || 0;
    const bytes = encodedBytes || transferBytes;
    const source = encodedBytes
      ? 'resource-timing-encoded'
      : transferBytes
        ? 'resource-timing-transfer'
        : '';
    const contentType = typeof entry.contentType === 'string' ? entry.contentType : '';
    const existing = timings.get(entry.name);
    const shouldReplace =
      !existing ||
      (source === 'resource-timing-encoded' && existing.source !== source) ||
      (source === existing.source && bytes > existing.bytes);
    if ((bytes > 0 || contentType) && shouldReplace) {
      timings.set(entry.name, { bytes, contentType, source });
    }
  }

  const unsupported = {
    canvas: 0,
    imageSetSelection: 0
  };

  const decodeCssEscapes = (value) =>
    value.replace(
      /\\([0-9a-fA-F]{1,6})(?:\r\n|[\t\n\f\r ])?|\\(?:\r\n|[\n\f\r])|\\(.)/gs,
      (match, hex, character) => {
        if (hex) {
          const codePoint = Number.parseInt(hex, 16);
          return codePoint === 0 || codePoint > 0x10ffff ? '\uFFFD' : String.fromCodePoint(codePoint);
        }
        return character || '';
      }
    );

  const readFunction = (input, openIndex) => {
    let depth = 1;
    let quote = '';
    let escaped = false;
    for (let index = openIndex + 1; index < input.length; index += 1) {
      const character = input[index];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (character === '\\') {
        escaped = true;
        continue;
      }
      if (quote) {
        if (character === quote) quote = '';
        continue;
      }
      if (character === '"' || character === "'") {
        quote = character;
        continue;
      }
      if (character === '(') depth += 1;
      if (character === ')') {
        depth -= 1;
        if (depth === 0) return { body: input.slice(openIndex + 1, index), end: index + 1 };
      }
    }
    return { body: input.slice(openIndex + 1), end: input.length };
  };

  const splitTopLevel = (input) => {
    const parts = [];
    let start = 0;
    let depth = 0;
    let quote = '';
    let escaped = false;
    for (let index = 0; index < input.length; index += 1) {
      const character = input[index];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (character === '\\') {
        escaped = true;
        continue;
      }
      if (quote) {
        if (character === quote) quote = '';
        continue;
      }
      if (character === '"' || character === "'") {
        quote = character;
        continue;
      }
      if (character === '(') depth += 1;
      else if (character === ')') depth = Math.max(0, depth - 1);
      else if (character === ',' && depth === 0) {
        parts.push(input.slice(start, index));
        start = index + 1;
      }
    }
    parts.push(input.slice(start));
    return parts;
  };

  const cssResolution = (candidate) => {
    const match = /(?:^|\s)([0-9]+(?:\.[0-9]+)?|\.[0-9]+)(x|dppx|dpi|dpcm)(?=\s|$)/i.exec(candidate);
    if (!match) return 1;
    const value = Number(match[1]);
    if (match[2].toLowerCase() === 'dpi') return value / 96;
    if (match[2].toLowerCase() === 'dpcm') return value / 37.8;
    return value;
  };

  const cssImages = (input) => {
    const found = [];
    let selectionUnknown = 0;

    const walk = (value) => {
      let index = 0;
      while (index < value.length) {
        if (!/[a-z_-]/i.test(value[index])) {
          index += 1;
          continue;
        }
        const start = index;
        while (index < value.length && /[a-z0-9_-]/i.test(value[index])) index += 1;
        const name = value.slice(start, index).toLowerCase();
        while (index < value.length && isSpace(value[index])) index += 1;
        if (value[index] !== '(') continue;
        const fn = readFunction(value, index);
        index = fn.end;

        if (name === 'url') {
          let raw = fn.body.trim();
          if (
            raw.length >= 2 &&
            ((raw.startsWith('"') && raw.endsWith('"')) ||
              (raw.startsWith("'") && raw.endsWith("'")))
          ) {
            raw = raw.slice(1, -1);
          }
          const url = absolute(decodeCssEscapes(raw));
          if (url) found.push(url);
          continue;
        }

        if (name === 'image-set' || name === '-webkit-image-set') {
          const candidates = splitTopLevel(fn.body).map((candidate) => {
            const before = found.length;
            walk(candidate);
            const urls = found.splice(before);
            return {
              candidate,
              url: urls[0] || '',
              density: cssResolution(candidate),
              typed: /\btype\s*\(/i.test(candidate)
            };
          }).filter((candidate) => candidate.url);

          const loaded = candidates.filter((candidate) => timingNames.has(candidate.url));
          if (loaded.length === 1) {
            found.push(loaded[0].url);
          } else if (loaded.length > 1) {
            selectionUnknown += 1;
          } else if (candidates.some((candidate) => candidate.typed)) {
            selectionUnknown += 1;
          } else if (candidates.length) {
            const ordered = [...candidates].sort((a, b) => a.density - b.density);
            const selected = ordered.find((candidate) => candidate.density >= dpr) || ordered.at(-1);
            found.push(selected.url);
          }
          continue;
        }

        walk(fn.body);
      }
    };

    walk(input || '');
    return { urls: [...new Set(found)], selectionUnknown };
  };

  const elements = [];
  let truncated = false;
  const roots = [document];
  while (roots.length > 0) {
    const root = roots.shift();
    for (const element of root.querySelectorAll('*')) {
      if (elements.length >= maxElements) {
        truncated = true;
        break;
      }
      elements.push(element);
      if (element.shadowRoot) roots.push(element.shadowRoot);
    }
    if (truncated) break;
  }

  for (const element of elements) {
    if (previousMarkAttribute && element.hasAttribute(previousMarkAttribute)) {
      element.removeAttribute(previousMarkAttribute);
    }
  }

  const resources = new Map();
  const usages = [];
  const elementIds = new WeakMap();
  const styles = new WeakMap();
  let serializedUrlChars = 0;
  let skippedResources = 0;
  let skippedUsages = 0;
  let recordsTruncated = false;
  let styleScanTruncated = false;
  let nextElementId = 0;

  const styleOf = (element, pseudo = '') => {
    if (!pseudo && styles.has(element)) return styles.get(element);
    try {
      const style = getComputedStyle(element, pseudo || null);
      if (!pseudo) styles.set(element, style);
      return style;
    } catch {
      return null;
    }
  };

  const inlineSize = (url) => {
    const comma = url.indexOf(',');
    if (comma < 0) return 0;
    const payload = url.slice(comma + 1);
    if (/;base64(?:;|,|$)/i.test(url.slice(0, comma + 1))) {
      const clean = payload.replace(/[\t\n\f\r ]/g, '');
      return Math.max(0, Math.floor((clean.length * 3) / 4) - clean.match(/=*$/)[0].length);
    }
    try {
      return new TextEncoder().encode(decodeURIComponent(payload)).length;
    } catch {
      return payload.length;
    }
  };

  const mergeDimensions = (resource, dimensions) => {
    if (!(dimensions.width > 0) || !(dimensions.height > 0)) return;
    if (resource.sourceDimensionReason === 'conflict') return;
    if (!resource.sourcePixelWidth) {
      resource.sourcePixelWidth = dimensions.width;
      resource.sourcePixelHeight = dimensions.height;
      resource.sourceDimensionConfidence = dimensions.confidence;
      return;
    }
    if (
      resource.sourcePixelWidth !== dimensions.width ||
      resource.sourcePixelHeight !== dimensions.height
    ) {
      resource.sourcePixelWidth = 0;
      resource.sourcePixelHeight = 0;
      resource.sourceDimensionConfidence = 'unknown';
      resource.sourceDimensionReason = 'conflict';
    } else if (dimensions.confidence === 'descriptor') {
      resource.sourceDimensionConfidence = 'descriptor';
    }
  };

  const ensureResource = (url, dimensions) => {
    const existing = resources.get(url);
    if (existing) {
      mergeDimensions(existing, dimensions);
      return existing;
    }
    if (
      url.length > maxUrlLength ||
      resources.size >= maxResources ||
      serializedUrlChars + url.length > maxSerializedUrlChars
    ) {
      skippedResources += 1;
      recordsTruncated = true;
      return null;
    }

    const timing = timings.get(url);
    const inlineBytes = url.startsWith('data:') ? inlineSize(url) : 0;
    const resource = {
      id: `r${resources.size + 1}`,
      url,
      transferBytes: inlineBytes || (timing && timing.bytes) || 0,
      contentType: (timing && timing.contentType) || '',
      measurementSource: inlineBytes ? 'inline' : (timing && timing.source) || '',
      measurementConfidence: inlineBytes ? 'medium' : timing && timing.source ? 'high' : '',
      sourcePixelWidth: 0,
      sourcePixelHeight: 0,
      sourceDimensionConfidence: 'unknown',
      sourceDimensionReason: '',
      isDataUri: url.startsWith('data:')
    };
    mergeDimensions(resource, dimensions);
    resources.set(url, resource);
    serializedUrlChars += url.length;
    return resource;
  };

  // Scan-local serialization labels only: `r1`/`u1` ids and auditor mark
  // values identify rows within one report. The UI wave must key continuity
  // on frame-document identity plus resource URL plus the weak element path
  // recorded as `stableKey` on each usage, never on these labels.
  const elementIdOf = (element) => {
    let id = elementIds.get(element);
    if (!id) {
      nextElementId += 1;
      id = String(nextElementId);
      elementIds.set(element, id);
      element.setAttribute(markAttribute, id);
    }
    return id;
  };

  // Weak element identity hook: a short ancestor path that survives rescans
  // while the surrounding structure is unchanged, and changes (correctly
  // invalidating continuity) when the element moves. Best effort only.
  const domPathOf = (element) => {
    try {
      const parts = [];
      let node = element;
      for (let depth = 0; node && depth < 8; depth += 1) {
        const parent = node.parentElement;
        let index = -1;
        if (parent && parent.children) {
          try { index = Array.prototype.indexOf.call(parent.children, node); } catch { index = -1; }
        }
        parts.push(`${node.tagName || node.localName || '?'}[${index}]`);
        node = parent;
      }
      return parts.reverse().join('/');
    } catch {
      return '';
    }
  };
  // Frame-document identity for stable UI keys. Read lazily: the tracker is
  // owned by the observer and may be replaced between scans.
  const usageDocumentToken = () => {
    try {
      const tracker = watchKey ? globalThis[watchKey] : null;
      if (tracker?.documentToken) return String(tracker.documentToken);
      return String(performance.timeOrigin || 0);
    } catch {
      return '';
    }
  };

  const addUsage = (url, element, kind, fields = {}, dimensions = {}) => {
    if (!url || url.startsWith('blob:')) return;
    if (usages.length >= maxUsages) {
      skippedUsages += 1;
      recordsTruncated = true;
      return;
    }
    const resource = ensureResource(url, dimensions);
    if (!resource) {
      skippedUsages += 1;
      return;
    }

    const rect = element.getBoundingClientRect();
    usages.push({
      id: `u${usages.length + 1}`,
      resourceId: resource.id,
      elementId: elementIdOf(element),
      kind,
      cssProperty: '',
      displayWidth: Math.round(rect.width),
      displayHeight: Math.round(rect.height),
      dpr,
      viewportWidth,
      inViewport:
        rect.top < viewportHeight &&
        rect.bottom > 0 &&
        rect.left < viewportWidth &&
        rect.right > 0 &&
        rect.width > 0 &&
        rect.height > 0,
      loading: '',
      fetchPriority: '',
      decoding: '',
      altState: 'not-applicable',
      hasDimensions: true,
      hasSrcset: true,
      hasSizes: true,
      usesWidthDescriptors: false,
      pictureFallbackSelected: false,
      densityCorrectedWidth: 0,
      densityCorrectedHeight: 0,
      selectedCandidateDescriptor: '',
      layoutShiftCount: 0,
      layoutShiftScore: 0,
      ...fields,
      documentToken: usageDocumentToken(),
      stableKey: [usageDocumentToken(), url, kind, fields.cssProperty || '', domPathOf(element)].join('|')
    });
  };

  // Semantic sources first: they remain covered even if the CSS style budget expires.
  for (const element of elements) {
    if (element instanceof HTMLImageElement) {
      const url = absolute(element.currentSrc || element.src);
      if (url && !url.startsWith('blob:')) {
        const hasDimensionAttributes =
          element.hasAttribute('width') && element.hasAttribute('height');
        const style = hasDimensionAttributes ? null : styleOf(element);
        const naturalWidth = element.naturalWidth || 0;
        const naturalHeight = element.naturalHeight || 0;
        const parent = element.parentElement;
        const sources = [];
        if (parent && parent.tagName === 'PICTURE') {
          for (const child of parent.children) {
            if (child === element) break;
            if (child.tagName === 'SOURCE') sources.push(child);
          }
        }

        const ownSrcset = element.getAttribute('srcset') || '';
        const sourceSrcsets = sources.map((source) => source.getAttribute('srcset') || '');
        const hasSrcset = Boolean(ownSrcset.trim() || sourceSrcsets.some((value) => value.trim()));
        const selection = selectedSource(element, url, sources);
        const fallback = absolute(element.getAttribute('src') || '');
        const pictureFallbackSelected =
          sources.length > 0 &&
          selection.owner === element &&
          !ownSrcset.trim() &&
          fallback === url;
        const dimensions = candidateDimensions(selection, naturalWidth, naturalHeight);

        addUsage(
          url,
          element,
          'img',
          {
            loading: element.loading || 'eager',
            fetchPriority: element.fetchPriority || element.getAttribute('fetchpriority') || 'auto',
            decoding: element.decoding || element.getAttribute('decoding') || 'auto',
            altState: !element.hasAttribute('alt')
              ? 'missing'
              : element.getAttribute('alt').trim()
                ? 'non-empty'
                : 'empty',
            hasDimensions: Boolean(
              hasDimensionAttributes ||
                (style?.aspectRatio && style.aspectRatio !== 'auto')
            ),
            hasSrcset,
            hasSizes: selection.owner ? selection.owner.hasAttribute('sizes') : true,
            usesWidthDescriptors: selection.candidates.some((candidate) => candidate.width > 0),
            pictureFallbackSelected,
            densityCorrectedWidth: naturalWidth,
            densityCorrectedHeight: naturalHeight,
            selectedCandidateDescriptor: dimensions.descriptor,
            sourceDimensionConfidence: dimensions.confidence
          },
          dimensions
        );
      }
    }

    if (element instanceof HTMLVideoElement && element.hasAttribute('poster')) {
      addUsage(absolute(element.getAttribute('poster')), element, 'poster');
    }

    if (
      (element.localName === 'image' || element.tagName === 'IMAGE') &&
      (element.namespaceURI === 'http://www.w3.org/2000/svg' || element.ownerSVGElement)
    ) {
      const href = element.href?.baseVal || element.getAttribute('href') || element.getAttribute('xlink:href');
      addUsage(absolute(href), element, 'svg-image');
    }

    if (element.tagName === 'CANVAS') unsupported.canvas += 1;
  }

  const scanStyle = (element, style, pseudo = '') => {
    if (!style) return;
    const properties = [
      ['background-image', style.backgroundImage, 'background'],
      [
        'mask-image',
        style.maskImage && style.maskImage !== 'none' ? style.maskImage : style.webkitMaskImage,
        'mask'
      ],
      ['border-image-source', style.borderImageSource, 'border'],
      ['content', style.content, 'generated-content']
    ];
    for (const [cssProperty, value, baseKind] of properties) {
      if (!value || value === 'none' || value === 'normal') continue;
      const parsed = cssImages(value);
      unsupported.imageSetSelection += parsed.selectionUnknown;
      for (const url of parsed.urls) {
        addUsage(url, element, pseudo ? `pseudo-${pseudo}` : baseKind, { cssProperty });
      }
    }
  };

  for (const element of elements) {
    if (now() - scanStart >= maxScanDurationMs) {
      styleScanTruncated = true;
      break;
    }
    scanStyle(element, styleOf(element));
    scanStyle(element, styleOf(element, '::before'), 'before');
    scanStyle(element, styleOf(element, '::after'), 'after');
  }

  const tracker = watchKey ? globalThis[watchKey] : null;
  const markerForNode = (node) => {
    let element = node?.nodeType === 1 ? node : node?.parentElement;
    for (let depth = 0; element && depth < 8; depth += 1) {
      const direct = elementIds.get(element);
      if (direct) return direct;
      element = element.parentElement;
    }
    if (node?.nodeType === 1 && typeof node.querySelectorAll === 'function') {
      for (const descendant of node.querySelectorAll('*')) {
        const id = elementIds.get(descendant);
        if (id) return id;
      }
    }
    return '';
  };

  let lcp = null;
  let cls = {
    supported: Boolean(tracker?.clsSupported),
    score: 0,
    totalScore: 0,
    shiftCount: 0,
    attributedShiftCount: 0,
    entriesTruncated: Boolean(tracker?.layoutShiftsTruncated)
  };

  if (tracker?.lcp) {
    const entry = tracker.lcp;
    const elementId = markerForNode(entry.element);
    lcp = {
      supported: true,
      time: Number(entry.startTime) || Number(entry.renderTime) || Number(entry.loadTime) || 0,
      size: Number(entry.size) || 0,
      url: absolute(entry.url || '').slice(0, maxUrlLength),
      tagName: entry.element?.tagName?.toLowerCase() || '',
      elementId
    };
    for (const usage of usages) usage.isLcp = Boolean(elementId && usage.elementId === elementId);
  } else if (tracker) {
    lcp = { supported: Boolean(tracker.lcpSupported), time: 0, size: 0, url: '', tagName: '', elementId: '' };
  }

  if (tracker?.layoutShifts?.length) {
    const shifts = [...tracker.layoutShifts].sort((a, b) => a.startTime - b.startTime);
    const attribution = new Map();
    let windowStart = null;
    let previousTime = 0;
    let windowScore = 0;
    let maxWindowScore = 0;
    let attributedShiftCount = 0;

    for (const entry of shifts) {
      const time = Number(entry.startTime) || 0;
      if (windowStart === null || time - previousTime > 1000 || time - windowStart > 5000) {
        windowStart = time;
        windowScore = 0;
      }
      previousTime = time;
      windowScore += Number(entry.value) || 0;
      maxWindowScore = Math.max(maxWindowScore, windowScore);

      const ids = new Set();
      for (const source of entry.sources || []) {
        const id = markerForNode(source.node);
        if (id) ids.add(id);
      }
      if (ids.size) attributedShiftCount += 1;
      for (const id of ids) {
        const fact = attribution.get(id) || { count: 0, score: 0 };
        fact.count += 1;
        fact.score += Number(entry.value) || 0;
        attribution.set(id, fact);
      }
    }

    for (const usage of usages) {
      const fact = attribution.get(usage.elementId);
      if (!fact) continue;
      usage.layoutShiftCount = fact.count;
      usage.layoutShiftScore = Number(fact.score.toFixed(4));
    }
    cls = {
      ...cls,
      score: Number(maxWindowScore.toFixed(4)),
      totalScore: Number(shifts.reduce((total, entry) => total + (Number(entry.value) || 0), 0).toFixed(4)),
      shiftCount: shifts.length,
      attributedShiftCount
    };
  }

  const result = {
    pageUrl: location.href.slice(0, maxUrlLength),
    pageTitle: document.title.slice(0, 1000),
    viewport: { width: viewportWidth, height: viewportHeight, dpr },
    scannedElements: elements.length,
    scanDurationMs: Math.round((now() - scanStart) * 10) / 10,
    truncated,
    styleScanTruncated,
    recordsTruncated,
    skippedResources,
    skippedUsages,
    timingBufferFull,
    unsupported,
    watch: tracker
      ? {
          documentToken: String(performance.timeOrigin || 0),
          generation: tracker.generation,
          revision: tracker.revision ?? tracker.generation,
          mutationCount: tracker.mutationCount,
          lastMutationTime: tracker.lastMutationTime
        }
      : null,
    vitals: {
      lcp,
      cls
    },
    resources: [...resources.values()],
    usages
  };

  const payloadBytes = () => new TextEncoder().encode(JSON.stringify(result)).length;
  while (payloadBytes() > maxSerializedPayloadBytes && result.usages.length) {
    const size = payloadBytes();
    const keep = Math.min(
      result.usages.length - 1,
      Math.floor(result.usages.length * (maxSerializedPayloadBytes / size) * 0.9)
    );
    const removed = result.usages.splice(Math.max(0, keep));
    result.skippedUsages += removed.length;
    const used = new Set(result.usages.map((usage) => usage.resourceId));
    const resourceCount = result.resources.length;
    result.resources = result.resources.filter((resource) => used.has(resource.id));
    result.skippedResources += resourceCount - result.resources.length;
    result.recordsTruncated = true;
  }
  return result;
}
