/**
 * A DOM small enough to run `collectImages` in plain Node.
 *
 * It supplies only what the collector reads. That keeps the project free of
 * dependencies, and it keeps the stub honest: a new DOM call in the collector
 * fails here first.
 */

const DEFAULT_RECT = { top: 0, bottom: 100, left: 0, right: 100, width: 100, height: 100 };
const DEFAULT_STYLE = {
  aspectRatio: 'auto',
  backgroundImage: 'none',
  maskImage: 'none',
  webkitMaskImage: 'none',
  borderImageSource: 'none',
  content: 'normal'
};

export class FakeElement {
  /**
   * @param {string} tag
   * @param {object} options attributes, rect, style, props, children
   */
  constructor(tag, options = {}) {
    this.tagName = tag.toUpperCase();
    this.nodeType = 1;
    this.attributes = { ...(options.attributes || {}) };
    this.rect = { ...DEFAULT_RECT, ...(options.rect || {}) };
    this.computed = { ...DEFAULT_STYLE, ...(options.style || {}) };
    this.pseudoComputed = Object.fromEntries(
      Object.entries(options.pseudoStyles || {}).map(([pseudo, style]) => [
        pseudo,
        { ...DEFAULT_STYLE, ...style }
      ])
    );
    this.children = [];
    this.parentElement = null;
    this.shadowRoot = null;
    Object.assign(this, options.props || {});
    this.append(...(options.children || []));
  }

  append(...nodes) {
    for (const node of nodes) {
      node.parentElement = this;
      this.children.push(node);
    }
    return this;
  }

  attachShadow(...nodes) {
    this.shadowRoot = new FakeRoot(nodes);
    return this.shadowRoot;
  }

  hasAttribute(name) {
    return this.attributes[name] !== undefined;
  }

  getAttribute(name) {
    return this.attributes[name] ?? null;
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }

  removeAttribute(name) {
    delete this.attributes[name];
  }

  getAttributeNames() {
    return Object.keys(this.attributes);
  }

  getBoundingClientRect() {
    return this.rect;
  }

  descendants() {
    const out = [];
    for (const child of this.children) {
      out.push(child, ...child.descendants());
    }
    return out;
  }

  querySelectorAll(selector) {
    const all = this.descendants();
    if (selector === '*') return all;
    const tag = selector.toUpperCase();
    return all.filter((element) => element.tagName === tag);
  }
}

export class FakeImage extends FakeElement {
  constructor(options = {}) {
    super('img', options);
    this.naturalWidth = options.naturalWidth ?? 0;
    this.naturalHeight = options.naturalHeight ?? 0;
    this.loading = options.loading ?? 'eager';
    this.src = options.attributes?.src ?? '';
    this.currentSrc = options.currentSrc ?? this.src;
  }
}

export class FakeVideo extends FakeElement {
  constructor(options = {}) {
    super('video', options);
  }
}

class FakeRoot extends FakeElement {
  constructor(children) {
    super('root', { children });
  }
}

/**
 * Install the globals `collectImages` reads, and return a cleanup function.
 *
 * @param {object} options body, title, url, resources, viewport
 * @returns {() => void}
 */
export function installDom(options = {}) {
  const body = options.body ?? new FakeElement('body');
  const baseUrl = options.url ?? 'https://example.com/page';

  const document = {
    baseURI: baseUrl,
    title: options.title ?? 'Test page',
    querySelectorAll: (selector) => body.querySelectorAll(selector),
    images: body.querySelectorAll('img')
  };

  const saved = {};
  const globals = {
    window: {
      devicePixelRatio: options.viewport?.dpr ?? 1,
      innerWidth: options.viewport?.width ?? 1280,
      innerHeight: options.viewport?.height ?? 800,
      matchMedia: (query) => ({ matches: options.media?.[query] ?? false })
    },
    document,
    location: { href: baseUrl },
    performance: {
      timeOrigin: options.timeOrigin ?? 1000,
      now: options.now || (() => 0),
      getEntriesByType: () => options.resources ?? []
    },
    getComputedStyle: (element, pseudo) =>
      pseudo ? element.pseudoComputed[pseudo] || DEFAULT_STYLE : element.computed,
    HTMLImageElement: FakeImage,
    HTMLVideoElement: FakeVideo
  };

  for (const [name, value] of Object.entries(globals)) {
    saved[name] = globalThis[name];
    globalThis[name] = value;
  }

  return () => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete globalThis[name];
      else globalThis[name] = value;
    }
  };
}
