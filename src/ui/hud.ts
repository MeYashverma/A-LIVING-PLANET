/**
 * HUD: the fixed instrument bars, toasts, documentary captions and modal
 * dialogs. Everything it shows is read from the world through the host — the
 * numbers here are the same numbers the simulation uses.
 */
import { SEASON_NAMES } from '../core/time';
import { TIME } from '../core/config';
import { QUALITY_PRESETS, type QualityLevel } from '../core/config';
import type { Settings } from '../core/events';
import { SPECIES } from '../life/species';
import type { SimHost, ToolKind } from '../sim/host';
import type { WorldRenderer } from '../render/renderer';
import type { CameraMode, ScaleLevel } from '../render/cameraRig';

export interface HudCallbacks {
  onCameraMode(mode: CameraMode): void;
  onScale(level: ScaleLevel): void;
  onTool(tool: ToolKind): void;
  onNewWorld(): void;
  onLibrary(): void;
  onSave(): void;
  onSettings(): void;
  onHelp(): void;
  onDocumentary(): void;
  onTogglePanels(): void;
}

const CAMERA_MODES: { mode: CameraMode; label: string; key: string }[] = [
  { mode: 'free', label: 'Free', key: 'F' },
  { mode: 'follow', label: 'Follow', key: 'G' },
  { mode: 'cinematic', label: 'Cinematic', key: 'C' },
  { mode: 'overhead', label: 'Overhead', key: 'O' },
  { mode: 'organism', label: 'Close', key: 'V' },
];

const SCALE_LEVELS: { level: ScaleLevel; label: string }[] = [
  { level: 'planet', label: 'Planet' },
  { level: 'region', label: 'Region' },
  { level: 'local', label: 'Local' },
  { level: 'organism', label: 'Organism' },
  { level: 'micro', label: 'Micro' },
];

const TOOLS: { tool: ToolKind; label: string; hint: string }[] = [
  { tool: 'inspect', label: 'Inspect', hint: 'Click an animal to open its file. Drag to orbit, right-drag to pan.' },
  { tool: 'spawn', label: 'Release', hint: 'Click land to release animals of the selected species.' },
  { tool: 'plant', label: 'Sow', hint: 'Click to sow vegetation — grass, shrubs or reeds.' },
  { tool: 'tree', label: 'Plant tree', hint: 'Click to plant a stand of trees.' },
  { tool: 'raise', label: 'Raise', hint: 'Drag terrain up. Mountains change wind, rain and biomes.' },
  { tool: 'lower', label: 'Lower', hint: 'Drag terrain down — dig valleys, expose groundwater.' },
  { tool: 'flatten', label: 'Flatten', hint: 'Click to level the land under the cursor.' },
  { tool: 'water', label: 'Fill', hint: 'Click to pour water: ponds, streams, wetlands.' },
  { tool: 'drain', label: 'Drain', hint: 'Click to drain water from lakes and marshes.' },
  { tool: 'flood', label: 'Flood', hint: 'Click to flood the basin the cursor is over.' },
  { tool: 'fire', label: 'Ignite', hint: 'Click dry fuel to start a fire. Wind decides where it goes.' },
];

export class HUD {
  private host: SimHost;
  private cb: HudCallbacks;
  private topbar: HTMLElement;
  private bottombar: HTMLElement;
  private toasts: HTMLElement;
  private captions: HTMLElement;
  private modalLayer: HTMLElement;
  private hintEl!: HTMLElement;
  private timeEl!: HTMLElement;
  private clockEl!: HTMLElement;
  private climateEl!: HTMLElement;
  private perfEl!: HTMLElement;
  private speedButtons = new Map<number, HTMLButtonElement>();
  private toolButtons = new Map<ToolKind, HTMLButtonElement>();
  private cameraButtons = new Map<CameraMode, HTMLButtonElement>();
  private scaleButtons = new Map<ScaleLevel, HTMLButtonElement>();
  private toastNodes: HTMLElement[] = [];
  private toolRadius = 26;
  private toolStrength = 1;
  private lastCaptionsKey = '';

  constructor(host: SimHost, cb: HudCallbacks) {
    this.host = host;
    this.cb = cb;
    this.topbar = el('div', 'ui bar');
    this.topbar.id = 'topbar';
    this.bottombar = el('div', 'ui bar');
    this.bottombar.id = 'bottombar';
    this.toasts = el('div', 'ui');
    this.toasts.id = 'toasts';
    this.captions = el('div', 'ui');
    this.captions.id = 'captions';
    this.modalLayer = el('div', 'ui');
    this.modalLayer.id = 'modal-layer';
    this.modalLayer.style.display = 'none';
    document.body.append(this.topbar, this.bottombar, this.toasts, this.captions, this.modalLayer);
    this.buildTop();
    this.buildBottom();
    host.onToast((text, kind) => this.toast(text, kind));
    host.onCaption((text, subject) => this.setCaption(text, subject));
  }

  /* ------------------------------------------------------------------ */
  /* Top bar                                                             */
  /* ------------------------------------------------------------------ */

  private buildTop(): void {
    const world = this.host.world;
    this.topbar.append(
      span('label', 'World'),
      (this.timeEl = span('value', world.name)),
      sep(),
      span('label', 'Seed'),
      span('value', world.seed),
      sep(),
      (this.clockEl = span('value mono', '')),
      (this.climateEl = span('value mono', '')),
      sep(),
      span('label', 'Speed'),
    );
    for (const option of [
      { label: '❚❚', value: 0 },
      { label: '1×', value: 1 },
      { label: '2×', value: 2 },
      { label: '5×', value: 5 },
      { label: '10×', value: 10 },
      { label: '25×', value: 25 },
      { label: '50×', value: 50 },
      { label: '100×', value: 100 },
    ]) {
      const b = button(option.label, 'btn mono', () => this.host.setSpeed(option.value));
      b.title = option.value === 0 ? 'Pause (space)' : `Simulate at ${option.value}× real time`;
      this.speedButtons.set(option.value, b);
      this.topbar.append(b);
    }
    this.topbar.append(sep(), span('label', 'Jump'));
    for (const [label, kind, title] of [
      ['+1h', 'hour', 'Advance one hour'],
      ['+1d', 'day', 'Advance one day'],
      ['+1w', 'week', 'Advance one week'],
      ['+1m', 'month', 'Advance thirty days'],
      ['+1y', 'year', 'Advance one year'],
    ] as const) {
      const b = button(label, 'btn mono', () => this.host.jump(kind));
      b.title = title;
      this.topbar.append(b);
    }
    this.topbar.append(sep(), (this.perfEl = span('value mono', '')));
    const grow = el('div', 'grow');
    const world2 = this.host.world;
    const nameInput = el('input') as HTMLInputElement;
    nameInput.type = 'text';
    nameInput.value = world2.name;
    nameInput.style.width = '132px';
    nameInput.title = 'World name';
    nameInput.addEventListener('change', () => {
      this.host.world.name = nameInput.value.trim() || world2.name;
      this.timeEl.textContent = this.host.world.name;
      this.host.dirty = true;
    });
    this.topbar.append(grow, nameInput, sep());
    this.topbar.append(
      button('Save', 'btn', () => this.cb.onSave()),
      button('Worlds', 'btn', () => this.cb.onLibrary()),
      button('New', 'btn', () => this.cb.onNewWorld()),
      button('Observer', 'btn', () => this.cb.onDocumentary()),
      button('Help', 'btn', () => this.cb.onHelp()),
    );
  }

  /* ------------------------------------------------------------------ */
  /* Bottom bar                                                          */
  /* ------------------------------------------------------------------ */

  private buildBottom(): void {
    const camRow = el('div', 'row tight');
    camRow.append(span('label', 'Camera'));
    for (const c of CAMERA_MODES) {
      const b = button(c.label, 'btn', () => this.cb.onCameraMode(c.mode));
      b.title = `${c.label} camera (${c.key})`;
      this.cameraButtons.set(c.mode, b);
      camRow.append(b);
    }
    camRow.append(sep(), span('label', 'Scale'));
    for (const s of SCALE_LEVELS) {
      const b = button(s.label, 'btn', () => this.cb.onScale(s.level));
      b.title = `${s.label} view`;
      this.scaleButtons.set(s.level, b);
      camRow.append(b);
    }

    const toolRow = el('div', 'row tight wrap tools');
    toolRow.append(span('label', 'Sandbox'));
    for (const t of TOOLS) {
      const b = button(t.label, 'btn tool', () => this.cb.onTool(t.tool));
      b.title = t.hint;
      this.toolButtons.set(t.tool, b);
      toolRow.append(b);
    }
    // Species picker for the release tool.
    const speciesSelect = el('select', 'btn mono') as HTMLSelectElement;
    for (const sp of SPECIES) {
      const opt = document.createElement('option');
      opt.value = sp.key;
      opt.textContent = sp.name;
      speciesSelect.append(opt);
    }
    speciesSelect.value = this.host.spawnSpecies;
    speciesSelect.title = 'Species released by the Release tool';
    speciesSelect.addEventListener('change', () => (this.host.spawnSpecies = speciesSelect.value));
    toolRow.append(speciesSelect);
    toolRow.append(span('label', 'Radius'));
    const radius = input('range', '0', '120', '2', String(this.toolRadius));
    radius.title = 'Brush radius in metres';
    radius.addEventListener('input', () => (this.toolRadius = Number(radius.value)));
    toolRow.append(radius);
    const radiusValue = span('value mono', `${this.toolRadius} m`);
    radius.addEventListener('input', () => (radiusValue.textContent = `${this.toolRadius} m`));
    toolRow.append(radiusValue);
    toolRow.append(span('label', 'Force'));
    const strength = input('range', '0.2', '3', '0.1', String(this.toolStrength));
    strength.title = 'Tool strength';
    strength.addEventListener('input', () => (this.toolStrength = Number(strength.value)));
    toolRow.append(strength);

    this.hintEl = el('div', 'hint dim small');
    this.hintEl.textContent = TOOLS[0].hint;
    this.bottombar.append(camRow, toolRow, this.hintEl);
    this.setTool('inspect');
  }

  get brushRadius(): number {
    return this.toolRadius;
  }

  get brushStrength(): number {
    return this.toolStrength;
  }

  /* ------------------------------------------------------------------ */
  /* State display                                                       */
  /* ------------------------------------------------------------------ */

  update(renderer: WorldRenderer): void {
    const world = this.host.world;
    const clock = world.clock;
    const hour = Math.floor(clock.hour);
    const minute = Math.floor((clock.hour % 1) * 60);
    this.timeEl.textContent = world.name;
    this.clockEl.textContent = `Y${clock.year} D${String(clock.dayOfYear + 1).padStart(3, '0')} ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')} ${SEASON_NAMES[clock.seasonIndex]}`;
    const climate = world.climate;
    const weather = climate.state.charAt(0).toUpperCase() + climate.state.slice(1);
    this.climateEl.textContent = `${weather} ${Math.round(climate.temperatureAt(0, 0))}°C ${Math.round(climate.windSpeed)}m/s`;
    const stats = renderer.stats;
    this.perfEl.textContent = `${stats.fps} fps · ${world.stats.simMs.toFixed(1)} ms sim · ${world.stats.creatures} animals`;
    for (const [value, b] of this.speedButtons) {
      const on = value === 0 ? clock.paused : !clock.paused && clock.speedIndex === TIME.speedSteps.indexOf(value as never);
      b.classList.toggle('on', on);
    }
  }

  setCameraMode(mode: CameraMode): void {
    for (const [m, b] of this.cameraButtons) b.classList.toggle('on', m === mode);
  }

  setScale(level: ScaleLevel): void {
    for (const [l, b] of this.scaleButtons) b.classList.toggle('on', l === level);
  }

  setTool(tool: ToolKind): void {
    this.host.tool = tool;
    for (const [t, b] of this.toolButtons) b.classList.toggle('on', t === tool);
    const found = TOOLS.find((t) => t.tool === tool);
    if (found) this.hintEl.textContent = found.hint;
  }

  setDocumentary(on: boolean): void {
    document.body.classList.toggle('documentary', on);
    if (!on) this.captions.replaceChildren();
  }

  /* ------------------------------------------------------------------ */
  /* Transient messages                                                  */
  /* ------------------------------------------------------------------ */

  toast(text: string, kind?: string): void {
    if (kind === 'extinct' || kind === 'disaster') {
      // Big events also land in the event log, so keep the toast brief.
    }
    const node = el('div', `toast ${kind ?? ''}`);
    node.textContent = text;
    this.toasts.append(node);
    this.toastNodes.push(node);
    while (this.toastNodes.length > 4) this.toastNodes.shift()?.remove();
    const ms = kind === 'extinct' || kind === 'disaster' ? 7000 : 4200;
    setTimeout(() => {
      node.style.transition = 'opacity 0.4s ease';
      node.style.opacity = '0';
      setTimeout(() => {
        node.remove();
        const i = this.toastNodes.indexOf(node);
        if (i >= 0) this.toastNodes.splice(i, 1);
      }, 420);
    }, ms);
  }

  private setCaption(text: string, subject: string): void {
    const key = `${subject}|${text}`;
    if (key === this.lastCaptionsKey) return;
    this.lastCaptionsKey = key;
    const node = el('div', 'caption');
    if (subject) {
      const who = el('span', 'who');
      who.textContent = SPECIES.find((s) => s.key === subject)?.name ?? subject;
      node.append(who);
    }
    node.append(document.createTextNode(text));
    this.captions.replaceChildren(node);
  }

  clearCaption(): void {
    this.captions.replaceChildren();
  }

  /* ------------------------------------------------------------------ */
  /* Modals                                                              */
  /* ------------------------------------------------------------------ */

  showModal(opts: { title: string; body: HTMLElement; actions?: { label: string; run: () => void; primary?: boolean }[]; onClose?: () => void }): void {
    const modal = el('div', 'modal');
    const header = el('header');
    const h1 = document.createElement('h1');
    h1.textContent = opts.title;
    header.append(h1);
    const body = el('div', 'body');
    body.append(opts.body);
    const footer = el('footer');
    for (const a of opts.actions ?? []) {
      const b = button(a.label, `btn${a.primary ? ' on' : ''}`, () => {
        a.run();
      });
      footer.append(b);
    }
    const close = button('Close', 'btn ghost', () => this.closeModal());
    footer.append(close);
    modal.append(header, body, footer);
    this.modalLayer.replaceChildren(modal);
    this.modalLayer.style.display = 'flex';
    this.modalLayer.dataset.hasModal = '1';
    (footer.querySelector('button') as HTMLButtonElement | null)?.focus();
    this.modalEsc = () => this.closeModal();
    document.addEventListener('keydown', this.modalEsc);
    this.onClose = opts.onClose ?? null;
  }

  private modalEsc: (() => void) | null = null;
  private onClose: (() => void) | null = null;

  closeModal(): void {
    this.modalLayer.style.display = 'none';
    this.modalLayer.replaceChildren();
    delete this.modalLayer.dataset.hasModal;
    if (this.modalEsc) document.removeEventListener('keydown', this.modalEsc);
    this.modalEsc = null;
    this.onClose?.();
    this.onClose = null;
  }

  get modalOpen(): boolean {
    return this.modalLayer.dataset.hasModal === '1';
  }

  /* ------------------------------------------------------------------ */
  /* Standard dialogs                                                    */
  /* ------------------------------------------------------------------ */

  showHelp(): void {
    const body = el('div');
    const grid = el('div', 'help-grid');
    const rows: [string, string][] = [
      ['Space', 'Pause / resume'],
      ['1 – 7', 'Speeds 1×, 2×, 5×, 10×, 25×, 50×, 100×'],
      ['J / Shift+J', 'Advance a day / a week'],
      ['Left-drag', 'Orbit the camera'],
      ['Right / middle-drag', 'Pan across the land'],
      ['Wheel', 'Zoom in and out'],
      ['W A S D', 'Fly forward, back and sideways (hold Shift to hurry)'],
      ['Q E', 'Turn the camera (the mouse tilts it)'],
      ['Arrow keys', 'Same as W A S D, for one-handed flying'],
      ['Click', 'Select an animal, or apply the armed sandbox tool'],
      ['Double-click', 'Select an animal and follow it'],
      ['F G C O V', 'Free, Follow, Cinematic, Overhead, Close cameras'],
      ['P', 'Cycle Planet → Region → Local → Organism views'],
      ['D', 'Documentary mode: quiet, captioned observation'],
      ['Tab', 'Show or hide the instrument panels'],
      ['L', 'World library (save, load, export)'],
      ['?', 'This panel'],
    ];
    for (const [k, v] of rows) {
      const a = el('div');
      const kb = el('span', 'kbd');
      kb.textContent = k;
      a.append(kb);
      const b = el('div', 'dim');
      b.textContent = v;
      grid.append(a, b);
    }
    body.append(grid);
    const note = el('p', 'dim small');
    note.textContent =
      'Everything you see is simulated: the weather decides plant growth, plants decide the herbivores, herbivores decide the predators. Animals remember places, hold territories and learn nothing you did not watch happen.';
    body.append(note);
    this.showModal({ title: 'Field manual', body });
  }

  showSettings(settings: Settings, onChange: (patch: Partial<Settings>) => void, onReset: () => void): void {
    const body = el('div');
    const add = (label: string, control: HTMLElement) => {
      const field = el('div', 'field');
      const l = el('div', 'label');
      l.textContent = label;
      field.append(l, control);
      body.append(field);
    };
    const quality = el('select') as HTMLSelectElement;
    for (const q of Object.keys(QUALITY_PRESETS)) {
      const opt = document.createElement('option');
      opt.value = q;
      opt.textContent = q.charAt(0).toUpperCase() + q.slice(1);
      quality.append(opt);
    }
    quality.value = settings.quality;
    quality.addEventListener('change', () => onChange({ quality: quality.value as QualityLevel }));
    add('Render quality', quality);

    const vol = input('range', '0', '1', '0.05', String(settings.masterVolume));
    vol.addEventListener('input', () => onChange({ masterVolume: Number(vol.value) }));
    add('Master volume', vol);
    const amb = input('range', '0', '1', '0.05', String(settings.ambienceVolume));
    amb.addEventListener('input', () => onChange({ ambienceVolume: Number(amb.value) }));
    add('Ambience', amb);
    const mus = input('range', '0', '1', '0.05', String(settings.musicVolume));
    mus.addEventListener('input', () => onChange({ musicVolume: Number(mus.value) }));
    add('Music (sparse, off by default)', mus);
    const uiScale = input('range', '0.85', '1.4', '0.05', String(settings.uiScale));
    uiScale.addEventListener('input', () => onChange({ uiScale: Number(uiScale.value) }));
    add('Text and UI scale', uiScale);
    const particles = input('range', '0.2', '1', '0.1', String(settings.particleDensity));
    particles.addEventListener('input', () => onChange({ particleDensity: Number(particles.value) }));
    add('Particle density', particles);
    for (const [label, key] of [
      ['Reduced motion', 'reducedMotion'],
      ['High contrast', 'highContrast'],
      ['Colour-blind safe palette', 'colorblindSafe'],
      ['Show labels', 'showLabels'],
      ['Show trails', 'showTrails'],
      ['Autosave', 'autosave'],
      ['Documentary captions', 'documentaryCaptions'],
      ['Cinematic auto-rotate', 'autoRotateCinematic'],
    ] as const) {
      const cb = el('input') as HTMLInputElement;
      cb.type = 'checkbox';
      cb.checked = Boolean(settings[key]);
      cb.addEventListener('change', () => onChange({ [key]: cb.checked } as Partial<Settings>));
      add(label, cb);
    }
    this.showModal({ title: 'Settings', body, actions: [{ label: 'Reset to defaults', run: () => onReset() }] });
  }

  showReport(report: { title: string; lines: string[] }, onDismiss: () => void): void {
    const body = el('div');
    for (const line of report.lines) {
      const p = el('p', 'small');
      p.textContent = line;
      body.append(p);
    }
    this.showModal({
      title: report.title,
      body,
      actions: [{ label: 'Back to the field', run: () => this.closeModal(), primary: true }],
      onClose: onDismiss,
    });
  }

  showWorldCreator(
    onCreate: (seed: string, name: string, quality: QualityLevel) => void,
    randomSeed: () => string,
  ): void {
    const body = el('div');
    const nameRow = el('div', 'field');
    const nameLabel = el('div', 'label');
    nameLabel.textContent = 'World name';
    const name = el('input') as HTMLInputElement;
    name.type = 'text';
    name.value = 'New World';
    nameRow.append(nameLabel, name);
    const seedRow = el('div', 'field');
    const seedLabel = el('div', 'label');
    seedLabel.textContent = 'Seed';
    const seed = el('input') as HTMLInputElement;
    seed.type = 'text';
    seed.value = randomSeed();
    const regenerate = button('Regenerate', 'btn', () => (seed.value = randomSeed()));
    const seedWrap = el('div', 'row');
    seedWrap.append(seed, regenerate);
    seedRow.append(seedLabel, seedWrap);
    const qualityRow = el('div', 'field');
    const qLabel = el('div', 'label');
    qLabel.textContent = 'Detail';
    const quality = el('select') as HTMLSelectElement;
    for (const q of Object.keys(QUALITY_PRESETS)) {
      const opt = document.createElement('option');
      opt.value = q;
      opt.textContent = q.charAt(0).toUpperCase() + q.slice(1);
      quality.append(opt);
    }
    quality.value = 'high';
    qualityRow.append(qLabel, quality);
    const note = el('p', 'dim small');
    note.textContent =
      'Every world is generated from its seed: terrain, climate, rivers, soil, plants, then the animals that can live there. The same seed always produces the same planet.';
    body.append(nameRow, seedRow, qualityRow, note);
    this.showModal({
      title: 'Generate a world',
      body,
      actions: [{ label: 'Create', run: () => onCreate(seed.value.trim() || randomSeed(), name.value.trim() || 'World', quality.value as QualityLevel), primary: true }],
      onClose: () => this.captions.replaceChildren(),
    });
  }
}

/* ------------------------------------------------------------------ */
/* Small DOM helpers                                                   */
/* ------------------------------------------------------------------ */

function el(tag: string, className?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

function span(className: string, text: string): HTMLElement {
  const node = el('span', className);
  node.textContent = text;
  return node;
}

function sep(): HTMLElement {
  return el('div', 'sep');
}

function button(label: string, className: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = className;
  b.textContent = label;
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

function input(type: string, min: string, max: string, step: string, value: string): HTMLInputElement {
  const node = document.createElement('input');
  node.type = type;
  node.min = min;
  node.max = max;
  node.step = step;
  node.value = value;
  return node;
}
