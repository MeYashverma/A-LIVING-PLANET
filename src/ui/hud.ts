/**
 * HUD: the top instrument strip, the floating control dock, toasts, documentary
 * captions and modal dialogs. Everything it shows is read from the world through
 * the host — the numbers here are the same numbers the simulation uses.
 *
 * Layout (desktop): a slim top strip (world, clock, weather, speed, actions), a
 * floating dock at the bottom (camera, scale, sandbox tools), the minimap in the
 * lower-left corner and toasts under the strip on the right. Styling lives in
 * hud.css; this file only builds structure and keeps it in sync with the world.
 */
import './hud.css';
import { Minimap } from './minimap';
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

type ToolGroup = 'observe' | 'life' | 'land' | 'water' | 'fire';

const TOOL_GROUPS: { id: ToolGroup; label: string }[] = [
  { id: 'observe', label: 'Observe' },
  { id: 'life', label: 'Life' },
  { id: 'land', label: 'Land' },
  { id: 'water', label: 'Water' },
  { id: 'fire', label: 'Fire' },
];

const TOOLS: { tool: ToolKind; group: ToolGroup; label: string; hint: string }[] = [
  { tool: 'inspect', group: 'observe', label: 'Inspect', hint: 'Click an animal to open its file. Drag to orbit, right-drag to pan.' },
  { tool: 'spawn', group: 'life', label: 'Release', hint: 'Click land to release animals of the selected species.' },
  { tool: 'plant', group: 'life', label: 'Sow', hint: 'Click to sow vegetation — grass, shrubs or reeds.' },
  { tool: 'tree', group: 'life', label: 'Plant tree', hint: 'Click to plant a stand of trees.' },
  { tool: 'raise', group: 'land', label: 'Raise', hint: 'Drag terrain up. Mountains change wind, rain and biomes.' },
  { tool: 'lower', group: 'land', label: 'Lower', hint: 'Drag terrain down — dig valleys, expose groundwater.' },
  { tool: 'flatten', group: 'land', label: 'Flatten', hint: 'Click to level the land under the cursor.' },
  { tool: 'water', group: 'water', label: 'Fill', hint: 'Click to pour water: ponds, streams, wetlands.' },
  { tool: 'drain', group: 'water', label: 'Drain', hint: 'Click to drain water from lakes and marshes.' },
  { tool: 'flood', group: 'water', label: 'Flood', hint: 'Click to flood the basin the cursor is over.' },
  { tool: 'fire', group: 'fire', label: 'Ignite', hint: 'Click dry fuel to start a fire. Wind decides where it goes.' },
];

const SPEEDS: { label: string; value: number }[] = [
  { label: '❚❚', value: 0 },
  { label: '1×', value: 1 },
  { label: '2×', value: 2 },
  { label: '5×', value: 5 },
  { label: '10×', value: 10 },
  { label: '25×', value: 25 },
  { label: '50×', value: 50 },
  { label: '100×', value: 100 },
];

const JUMPS: [string, 'hour' | 'day' | 'week' | 'month' | 'year', string][] = [
  ['+1h', 'hour', 'Advance one hour'],
  ['+1d', 'day', 'Advance one day'],
  ['+1w', 'week', 'Advance one week'],
  ['+1m', 'month', 'Advance thirty days'],
  ['+1y', 'year', 'Advance one year'],
];

export class HUD {
  private host: SimHost;
  private cb: HudCallbacks;
  private topbar: HTMLElement;
  private dock: HTMLElement;
  private toasts: HTMLElement;
  private captions: HTMLElement;
  private modalLayer: HTMLElement;
  private hintEl!: HTMLElement;
  private nameInput!: HTMLInputElement;
  private dateEl!: HTMLElement;
  private seasonEl!: HTMLElement;
  private weatherEl!: HTMLElement;
  private perfEl!: HTMLElement;
  private speedButtons = new Map<number, HTMLButtonElement>();
  private toolButtons = new Map<ToolKind, HTMLButtonElement>();
  private toolGroupButtons = new Map<ToolGroup, HTMLButtonElement>();
  private toolGroupRow!: HTMLElement;
  private toolRow!: HTMLElement;
  private speciesSelect!: HTMLSelectElement;
  private cameraButtons = new Map<CameraMode, HTMLButtonElement>();
  private scaleButtons = new Map<ScaleLevel, HTMLButtonElement>();
  private toastNodes: HTMLElement[] = [];
  private toolRadius = 26;
  private toolStrength = 1;
  private activeGroup: ToolGroup = 'observe';
  private lastCaptionsKey = '';
  private minimap: Minimap;

  constructor(host: SimHost, cb: HudCallbacks) {
    this.host = host;
    this.cb = cb;
    this.minimap = new Minimap();

    this.topbar = el('header', 'hud-top ui');
    this.topbar.id = 'topbar';
    this.dock = el('div', 'hud-dock ui');
    this.dock.id = 'bottombar';
    this.toasts = el('div', 'hud-toasts ui');
    this.toasts.id = 'toasts';
    this.captions = el('div', 'hud-captions ui');
    this.captions.id = 'captions';
    this.modalLayer = el('div', 'hud-modal-layer ui');
    this.modalLayer.id = 'modal-layer';
    this.modalLayer.style.display = 'none';
    document.body.append(this.topbar, this.dock, this.toasts, this.captions, this.modalLayer);

    this.buildTop();
    this.buildDock();
    this.trackBarHeights();
    host.onToast((text, kind) => this.toast(text, kind));
    host.onCaption((text, subject) => this.setCaption(text, subject));
  }

  /**
   * Publish the real heights of the top strip and dock as CSS variables so side
   * columns, toasts and the minimap sit clear of them at any size or UI scale.
   */
  private trackBarHeights(): void {
    const root = document.documentElement;
    const apply = (): void => {
      root.style.setProperty('--topbar-h', `${Math.ceil(this.topbar.getBoundingClientRect().height)}px`);
      root.style.setProperty('--bottombar-h', `${Math.ceil(this.dock.getBoundingClientRect().height)}px`);
    };
    apply();
    if (typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(apply).observe(this.topbar);
      new ResizeObserver(apply).observe(this.dock);
    } else {
      window.addEventListener('resize', apply);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Top strip                                                           */
  /* ------------------------------------------------------------------ */

  private buildTop(): void {
    const world = this.host.world;

    // Identity: mark, product name, editable world name and seed.
    const brand = el('div', 'hud-brand');
    const mark = el('span', 'hud-mark');
    mark.innerHTML =
      '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M5 13c3-4 6 2 9-2s3 2 5 1" /></svg>';
    const brandText = el('div', 'hud-brand-text');
    brandText.append(span('hud-kicker', 'A Living Planet'));
    const nameInput = el('input', 'hud-name') as HTMLInputElement;
    this.nameInput = nameInput;
    nameInput.type = 'text';
    nameInput.value = world.name;
    nameInput.title = 'World name';
    nameInput.setAttribute('aria-label', 'World name');
    nameInput.addEventListener('change', () => {
      this.host.world.name = nameInput.value.trim() || world.name;
      nameInput.value = this.host.world.name;
      this.host.dirty = true;
    });
    const seed = span('hud-seed mono', `seed ${world.seed}`);
    seed.title = 'World seed: the same seed always produces the same planet';
    brandText.append(nameInput, seed);
    brand.append(mark, brandText);

    // Clock and weather: the read-out you glance at.
    const clock = el('div', 'hud-clock');
    const timeRow = el('div', 'hud-time-row');
    this.dateEl = span('hud-date', '');
    this.seasonEl = span('hud-season', '');
    timeRow.append(this.dateEl, this.seasonEl);
    this.perfEl = span('hud-time mono', '');
    this.weatherEl = span('hud-weather', '');
    clock.append(timeRow, this.perfEl, this.weatherEl);

    // Speed and time jumps.
    const speed = el('div', 'hud-group');
    speed.append(span('hud-label', 'Speed'));
    const speedSeg = el('div', 'hud-seg');
    for (const option of SPEEDS) {
      const b = button(option.label, 'hud-seg-btn mono', () => this.host.setSpeed(option.value));
      b.title = option.value === 0 ? 'Pause (space)' : `Simulate at ${option.value}× real time`;
      this.speedButtons.set(option.value, b);
      speedSeg.append(b);
    }
    const jump = el('div', 'hud-group hud-jump');
    jump.append(span('hud-label', 'Jump'));
    const jumpSeg = el('div', 'hud-seg');
    for (const [label, kind, title] of JUMPS) {
      const b = button(label, 'hud-seg-btn mono', () => this.host.jump(kind));
      b.title = title;
      jumpSeg.append(b);
    }
    jump.append(jumpSeg);
    speed.append(speedSeg);

    // Panels, settings and file actions.
    const actions = el('div', 'hud-actions');
    actions.append(
      iconButton('Panels', 'Show or hide the side panels (Tab)', () => this.cb.onTogglePanels(), ICON.panels),
      iconButton('Observer', 'Documentary mode: quiet, captioned observation (D)', () => this.cb.onDocumentary(), ICON.eye),
      iconButton('Settings', 'Settings', () => this.cb.onSettings(), ICON.gear),
      iconButton('Help', 'Field manual (?)', () => this.cb.onHelp(), ICON.help),
    );
    const files = el('div', 'hud-group hud-files');
    files.append(
      textButton('Save', 'Save this world', () => this.cb.onSave()),
      textButton('Worlds', 'World library (L)', () => this.cb.onLibrary()),
      textButton('New', 'Generate a new world', () => this.cb.onNewWorld()),
    );

    this.topbar.append(brand, clock, el('div', 'hud-spacer'), speed, jump, actions, files);
    this.topbar.setAttribute('role', 'banner');
  }

  /* ------------------------------------------------------------------ */
  /* Dock                                                                */
  /* ------------------------------------------------------------------ */

  private buildDock(): void {
    const camGroup = el('div', 'hud-group');
    camGroup.append(span('hud-label', 'Camera'));
    const camSeg = el('div', 'hud-seg');
    for (const c of CAMERA_MODES) {
      const b = button(c.label, 'hud-seg-btn', () => this.cb.onCameraMode(c.mode));
      b.title = `${c.label} camera (${c.key})`;
      b.append(span('hud-key', c.key));
      this.cameraButtons.set(c.mode, b);
      camSeg.append(b);
    }
    camGroup.append(camSeg);

    const scaleGroup = el('div', 'hud-group');
    scaleGroup.append(span('hud-label', 'Scale'));
    const scaleSeg = el('div', 'hud-seg');
    for (const s of SCALE_LEVELS) {
      const b = button(s.label, 'hud-seg-btn', () => this.cb.onScale(s.level));
      b.title = `${s.label} view`;
      this.scaleButtons.set(s.level, b);
      scaleSeg.append(b);
    }
    scaleGroup.append(scaleSeg);

    // Sandbox: a category row, then the tools of the active category.
    const sandbox = el('div', 'hud-sandbox');
    this.toolGroupRow = el('div', 'hud-seg hud-groups');
    for (const g of TOOL_GROUPS) {
      const b = button(g.label, 'hud-seg-btn', () => this.showToolGroup(g.id));
      this.toolGroupButtons.set(g.id, b);
      this.toolGroupRow.append(b);
    }
    this.toolRow = el('div', 'hud-tools');

    this.speciesSelect = el('select', 'hud-select') as HTMLSelectElement;
    for (const sp of SPECIES) {
      const opt = document.createElement('option');
      opt.value = sp.key;
      opt.textContent = sp.name;
      this.speciesSelect.append(opt);
    }
    this.speciesSelect.value = this.host.spawnSpecies;
    this.speciesSelect.title = 'Species released by the Release tool';
    this.speciesSelect.setAttribute('aria-label', 'Species to release');
    this.speciesSelect.addEventListener('change', () => (this.host.spawnSpecies = this.speciesSelect.value));

    const radius = input('range', '0', '120', '2', String(this.toolRadius));
    radius.title = 'Brush radius in metres';
    const radiusValue = span('hud-value mono', `${this.toolRadius} m`);
    radius.addEventListener('input', () => {
      this.toolRadius = Number(radius.value);
      radiusValue.textContent = `${this.toolRadius} m`;
    });
    const strength = input('range', '0.2', '3', '0.1', String(this.toolStrength));
    strength.title = 'Tool strength';
    const strengthValue = span('hud-value mono', this.toolStrength.toFixed(1));
    strength.addEventListener('input', () => {
      this.toolStrength = Number(strength.value);
      strengthValue.textContent = this.toolStrength.toFixed(1);
    });
    const brush = el('div', 'hud-brush');
    brush.append(
      labelled('Radius', radius, radiusValue),
      labelled('Force', strength, strengthValue),
    );
    const sandboxRow = el('div', 'hud-sandbox-row');
    sandboxRow.append(this.toolGroupRow, this.speciesSelect, brush);
    sandbox.append(sandboxRow, this.toolRow);

    this.hintEl = el('div', 'hud-hint');
    const dockBody = el('div', 'hud-dock-body');
    dockBody.append(camGroup, scaleGroup, sandbox);
    this.dock.append(this.hintEl, dockBody);
    this.showToolGroup('observe');
    this.setTool('inspect');
  }

  private showToolGroup(group: ToolGroup): void {
    this.activeGroup = group;
    for (const [g, b] of this.toolGroupButtons) b.classList.toggle('on', g === group);
    this.toolRow.replaceChildren();
    for (const t of TOOLS.filter((x) => x.group === group)) {
      const b = button(t.label, 'hud-tool', () => this.cb.onTool(t.tool));
      b.title = t.hint;
      this.toolButtons.set(t.tool, b);
      this.toolRow.append(b);
    }
    this.speciesSelect.hidden = group !== 'life';
    this.setTool(this.host.tool as ToolKind);
  }

  /* ------------------------------------------------------------------ */
  /* Live state                                                          */
  /* ------------------------------------------------------------------ */

  get brushRadius(): number {
    return this.toolRadius;
  }

  get brushStrength(): number {
    return this.toolStrength;
  }

  update(renderer: WorldRenderer): void {
    const world = this.host.world;
    const clock = world.clock;
    const hour = Math.floor(clock.hour);
    const minute = Math.floor((clock.hour % 1) * 60);
    if (document.activeElement !== this.nameInput) this.nameInput.value = world.name;
    this.dateEl.textContent = `Year ${clock.year} · Day ${clock.dayOfYear + 1}`;
    this.seasonEl.textContent = `${SEASON_NAMES[clock.seasonIndex]} · ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
    const climate = world.climate;
    const weather = climate.state.charAt(0).toUpperCase() + climate.state.slice(1);
    this.weatherEl.textContent = `${weather} · ${Math.round(climate.temperatureAt(0, 0))}°C · wind ${Math.round(climate.windSpeed)} m/s`;
    this.minimap.update(world, renderer.rig.focus, renderer.rig.yaw);
    const stats = renderer.stats;
    this.perfEl.textContent = `${stats.fps} fps · ${world.stats.simMs.toFixed(1)} ms · ${world.stats.creatures} animals`;
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
    if (found) {
      this.hintEl.textContent = found.hint;
      if (found.group !== this.activeGroup) this.showToolGroup(found.group);
    }
  }

  setDocumentary(on: boolean): void {
    document.body.classList.toggle('documentary', on);
    if (!on) this.captions.replaceChildren();
  }

  /* ------------------------------------------------------------------ */
  /* Transient messages                                                  */
  /* ------------------------------------------------------------------ */

  toast(text: string, kind?: string): void {
    const node = el('div', `hud-toast ${kind ?? ''}`);
    const dot = el('span', 'hud-toast-dot');
    const msg = el('span', 'hud-toast-text');
    msg.textContent = text;
    node.append(dot, msg);
    this.toasts.append(node);
    this.toastNodes.push(node);
    while (this.toastNodes.length > 4) this.toastNodes.shift()?.remove();
    const ms = kind === 'extinct' || kind === 'disaster' ? 7000 : 4200;
    setTimeout(() => {
      node.classList.add('leaving');
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
    const node = el('div', 'hud-caption');
    if (subject) {
      const who = el('span', 'hud-caption-who');
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
    const modal = el('div', 'hud-modal');
    const header = el('header', 'hud-modal-head');
    const h1 = document.createElement('h1');
    h1.textContent = opts.title;
    header.append(h1);
    const close = iconButton('Close', 'Close (Esc)', () => this.closeModal(), ICON.close);
    close.classList.add('hud-modal-close');
    header.append(close);
    const body = el('div', 'hud-modal-body');
    body.append(opts.body);
    const footer = el('footer', 'hud-modal-foot');
    for (const a of opts.actions ?? []) {
      footer.append(button(a.label, `hud-btn${a.primary ? ' primary' : ''}`, () => a.run()));
    }
    footer.append(button('Close', 'hud-btn ghost', () => this.closeModal()));
    modal.append(header, body, footer);
    this.modalLayer.replaceChildren(modal);
    this.modalLayer.style.display = 'flex';
    this.modalLayer.dataset.hasModal = '1';
    (footer.querySelector('button') as HTMLButtonElement | null)?.focus();
    this.modalEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') this.closeModal();
    };
    document.addEventListener('keydown', this.modalEsc);
    this.onClose = opts.onClose ?? null;
  }

  private modalEsc: ((e: KeyboardEvent) => void) | null = null;
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
      ['Tab', 'Show or hide the side panels'],
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
    const regenerate = button('Regenerate', 'hud-btn', () => (seed.value = randomSeed()));
    const seedWrap = el('div', 'hud-inline');
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
/* Icons (inline SVG, stroke-based, 16px grid)                         */
/* ------------------------------------------------------------------ */

const ICON = {
  panels: '<rect x="2.5" y="3" width="11" height="10" rx="1.5"/><path d="M6.5 3v10"/>',
  eye: '<path d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/>',
  gear: '<circle cx="8" cy="8" r="2.2"/><path d="M8 1.8v1.7M8 12.5v1.7M1.8 8h1.7M12.5 8h1.7M3.6 3.6l1.2 1.2M11.2 11.2l1.2 1.2M3.6 12.4l1.2-1.2M11.2 4.8l1.2-1.2"/>',
  help: '<circle cx="8" cy="8" r="6"/><path d="M6.2 6.3a1.8 1.8 0 1 1 2.5 1.6c-.5.3-.7.6-.7 1.2M8 11.6v.1"/>',
  close: '<path d="M4 4l8 8M12 4l-8 8"/>',
};

function iconButton(label: string, title: string, onClick: () => void, path: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'hud-icon';
  b.title = title;
  b.setAttribute('aria-label', label);
  b.innerHTML = `<svg viewBox="0 0 16 16" aria-hidden="true">${path}</svg><span>${label}</span>`;
  b.addEventListener('click', onClick);
  return b;
}

function textButton(label: string, title: string, onClick: () => void): HTMLButtonElement {
  const b = button(label, 'hud-btn', onClick);
  b.title = title;
  return b;
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

function button(label: string, className: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = className;
  b.textContent = label;
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

function labelled(text: string, control: HTMLElement, value: HTMLElement): HTMLElement {
  const wrap = el('label', 'hud-slider');
  wrap.append(span('hud-label', text), control, value);
  return wrap;
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
