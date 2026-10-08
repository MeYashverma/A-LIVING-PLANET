/**
 * Entry point: builds the world, wires the renderer, the interface and the
 * audio to it, and runs the frame loop. Interaction is deliberately observable:
 * click to inspect, drag to look around, tools to change the world.
 */
import './ui/styles.css';
import { WorldRenderer } from './render/renderer';
import { TextureLibrary } from './render/textures';
import { Overlay } from './render/overlay';
import { HUD } from './ui/hud';
import { Panels } from './ui/panels';
import { Ambience } from './audio/ambience';
import { SimHost, applyAppearance, type ToolKind } from './sim/host';
import { QUALITY_PRESETS, type QualityLevel } from './core/config';
import { clamp } from './core/math';
import { speciesIndex } from './life/species';
import type { World } from './world/world';
import type { CameraMode, ScaleLevel } from './render/cameraRig';

const app = document.getElementById('app') as HTMLElement;
const viewport = document.getElementById('viewport') as HTMLElement;
const bootSub = document.getElementById('boot-sub') as HTMLElement;
const bootBar = document.getElementById('boot-bar') as HTMLElement;

let renderer: WorldRenderer | null = null;

let bootStage = 'start-up';

function bootStep(text: string, fraction: number): void {
  bootStage = text;
  bootSub.textContent = text;
  bootBar.style.width = `${Math.round(fraction * 100)}%`;
}

async function main(): Promise<void> {
  await new Promise((r) => requestAnimationFrame(() => r(null)));
  bootStep('generating terrain, hydrology and climate…', 0.15);
  await nextFrame();

  const settings = SimHost.loadSettings();
  applyAppearance(settings);
  const host = SimHost.create(SimHost.randomSeed(), 'Amber Basin', settings);
  bootStep('seeding soil, plants and animals…', 0.4);
  await nextFrame();

  // Textures load before the renderer is built: a material needs its maps at
  // compile time, not a promise of them.
  bootStage = 'loading materials';
  const textures = new TextureLibrary();
  await textures.load((p) => bootStep(`loading materials\u2026 ${Math.round(p * 100)}%`, 0.5 + p * 0.12));
  await nextFrame();

  bootStage = 'world renderer';
  renderer = new WorldRenderer(viewport, host.world, settings, textures);
  let current = host;

  bootStep('starting the frame loop…', 0.7);
  await nextFrame();

  bootStage = 'map overlay';
  const overlay = new Overlay(viewport);
  bootStage = 'ambient audio';
  const ambience = new Ambience();
  ambience.setVolumes(settings.masterVolume, settings.ambienceVolume, settings.musicVolume);

  bootStage = 'side panels';
  const panels = new Panels(host, {
    onFocusSpecies: (key) => focusSpecies(current, renderer!, key),
    onFocusEvent: (event) => focusEvent(current, renderer!, event),
    onSelectOrganism: (id) => current.select(id),
    onFollow: (id) => current.follow(id),
    onFavourite: (id) => current.favourite(id),
    onChange: () => {},
  });

  bootStage = 'instrument bar';
  const hud = new HUD(host, {
    onCameraMode: (mode) => setCamera(current, renderer!, mode),
    onScale: (level) => {
      const scale: ScaleLevel = level;
      renderer!.setScale(scale, current.world);
      hud.setScale(scale);
    },
    onTool: (tool) => hud.setTool(tool),
    onNewWorld: () => promptNewWorld(),
    onLibrary: () => showLibrary(),
    onSave: () => void saveWorld(),
    onSettings: () =>
      hud.showSettings(
        current.settings,
        (patch) => {
          current.applySettings(patch);
          renderer?.applySettings(current.settings);
          ambience.setVolumes(current.settings.masterVolume, current.settings.ambienceVolume, current.settings.musicVolume);
          renderer!.setViewOptions({ showLabels: current.settings.showLabels, showTrails: current.settings.showTrails }, current.world);
        },
        () => {
          current.resetSettings();
          renderer?.applySettings(current.settings);
        },
      ),
    onHelp: () => hud.showHelp(),
    onDocumentary: () => toggleDocumentary(),
    onTogglePanels: () => panels.togglePanels(),
  });

  renderer.setViewOptions({ showLabels: settings.showLabels, showTrails: settings.showTrails }, host.world);
  hud.setCameraMode('free');
  hud.setScale('region');

  /* ---------------------------------------------------------------- */
  /* New world / library                                              */
  /* ---------------------------------------------------------------- */

  function promptNewWorld(): void {
    hud.showWorldCreator(
      (seed, name, quality) => {
        hud.closeModal();
        bootStep('generating a new world…', 0.3);
        const nextSettings = { ...current.settings, quality };
        current.applySettings(nextSettings);
        const next = SimHost.create(seed, name, current.settings);
        swapWorld(next);
        bootStep('', 1);
        hideBoot();
        hud.toast(`Generated “${name}” from seed ${seed}.`, 'discovery');
      },
      () => SimHost.randomSeed(),
    );
  }

  async function showLibrary(): Promise<void> {
    const records = await current.store.list();
    const body = document.createElement('div');
    const list = document.createElement('div');
    const refresh = async () => {
      const all = await current.store.list();
      list.replaceChildren();
      if (!all.length) {
        const p = document.createElement('p');
        p.className = 'dim small';
        p.textContent = 'No saved worlds yet. Worlds autosave while you play; Save writes one immediately.';
        list.append(p);
      }
      for (const r of all) {
        const card = document.createElement('div');
        card.className = `world-card${r.id === current.recordId ? ' on' : ''}`;
        const left = document.createElement('div');
        const name = document.createElement('div');
        name.textContent = r.name;
        const meta = document.createElement('div');
        meta.className = 'small faint mono';
        const days = r.day;
        meta.textContent = `seed ${r.seed} · day ${days} · y${r.year} · ${r.population} animals · ${r.species} species · ${(r.byteSize / 1024).toFixed(0)} KB · saved ${new Date(r.savedAt).toLocaleString()}`;
        left.append(name, meta);
        const actions = document.createElement('div');
        actions.className = 'row tight';
        const loadBtn = document.createElement('button');
        loadBtn.className = 'btn';
        loadBtn.textContent = 'Open';
        loadBtn.addEventListener('click', async () => {
          hud.closeModal();
          const ok = await current.load(r.id);
          if (!ok) {
            hud.toast('That world could not be opened.', 'extinct');
            return;
          }
          // The host swaps its world inside `load`; rebuild everything around it.
          rebuildForCurrentWorld();
          if (current.pendingSummary) {
            const report = current.buildReport(current.pendingSummary);
            if (report) hud.showReport(report, () => (current.pendingSummary = null));
          }
        });
        const renameBtn = document.createElement('button');
        renameBtn.className = 'btn';
        renameBtn.textContent = 'Rename';
        renameBtn.addEventListener('click', async () => {
          const next = window.prompt('World name', r.name);
          if (!next) return;
          await current.rename(r.id, next);
          void refresh();
        });
        const dupBtn = document.createElement('button');
        dupBtn.className = 'btn';
        dupBtn.textContent = 'Duplicate';
        dupBtn.addEventListener('click', async () => {
          await current.duplicate(r.id, `${r.name} (copy)`);
          void refresh();
        });
        const delBtn = document.createElement('button');
        delBtn.className = 'btn';
        delBtn.textContent = 'Delete';
        delBtn.addEventListener('click', async () => {
          if (!window.confirm(`Delete “${r.name}”? This cannot be undone.`)) return;
          await current.deleteWorld(r.id);
          void refresh();
        });
        actions.append(loadBtn, renameBtn, dupBtn, delBtn);
        card.append(left, actions);
        list.append(card);
      }
    };
    await refresh();
    body.append(list);

    const importRow = document.createElement('div');
    importRow.className = 'row';
    importRow.style.marginTop = '10px';
    const importLabel = document.createElement('label');
    importLabel.className = 'btn';
    importLabel.textContent = 'Import world file';
    const importInput = document.createElement('input');
    importInput.type = 'file';
    importInput.accept = 'application/json,.json';
    importInput.style.display = 'none';
    importInput.addEventListener('change', async () => {
      const file = importInput.files?.[0];
      if (!file) return;
      try {
        await current.importWorld(file);
        hud.closeModal();
        rebuildForCurrentWorld();
        hud.toast(`Imported ${file.name}.`, 'discovery');
      } catch (err) {
        hud.toast(err instanceof Error ? err.message : 'Import failed.', 'extinct');
      }
    });
    importLabel.append(importInput);
    const exportBtn = document.createElement('button');
    exportBtn.className = 'btn';
    exportBtn.textContent = 'Export current world';
    exportBtn.addEventListener('click', () => current.exportWorld());
    const saveBtn = document.createElement('button');
    saveBtn.className = 'btn on';
    saveBtn.textContent = 'Save current';
    saveBtn.addEventListener('click', async () => {
      await saveWorld();
      void refresh();
    });
    importRow.append(saveBtn, exportBtn, importLabel);
    body.append(importRow);
    void records;
    hud.showModal({ title: 'World library', body });
  }

  async function saveWorld(): Promise<void> {
    await current.save();
    hud.toast(`Saved “${current.world.name}” (day ${current.world.clock.day}).`, 'discovery');
  }

  function rebuildForCurrentWorld(): void {
    const world = current.world;
    renderer?.dispose();
    renderer = new WorldRenderer(viewport, world, current.settings, textures);
    renderer.applySettings(current.settings);
    renderer.setViewOptions({ showLabels: current.settings.showLabels, showTrails: current.settings.showTrails }, world);
    current.select(null);
    panels.setTab('organism');
    hud.setCameraMode('free');
  }

  function swapWorld(next: SimHost): void {
    current = next;
    host.world = next.world; // panels/HUD read through the original host object
    rebuildForCurrentWorld();
  }

  /* ---------------------------------------------------------------- */
  /* Observation helpers                                              */
  /* ---------------------------------------------------------------- */

  function focusSpecies(h: SimHost, r: WorldRenderer, key: string): void {
    // Find the nearest living individual and move the camera onto it.
    const world = h.world;
    const c = world.creatures;
    const idx = world.census.get(key);
    if (!idx || idx.count === 0) return;
    const speciesIdx = speciesIndex(key);
    let best = -1;
    let bestDist = Infinity;
    for (let i = 0; i < c.capacity; i++) {
      if (!c.alive[i] || c.speciesIdx[i] !== speciesIdx) continue;
      const d = Math.hypot(c.x[i] - r.rig.focus.x, c.y[i] - r.rig.focus.z);
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    }
    if (best < 0) return;
    h.select(c.id[best]);
    r.rig.glideTo(c.x[best], c.y[best], 60);
    r.rig.trackSubject(world, c.id[best], 26);
    r.rig.setMode('follow', world, c.id[best]);
    hud.setCameraMode('follow');
  }

  function focusEvent(h: SimHost, r: WorldRenderer, event: { x?: number; y?: number; organismId?: number }): void {
    if (event.organismId !== undefined) {
      const slot = h.world.creatures.findByLivingId(event.organismId);
      if (slot >= 0) {
        h.select(event.organismId);
        panels.setTab('organism');
      }
    }
    if (event.x !== undefined && event.y !== undefined) r.rig.glideTo(event.x, event.y, 90);
  }

  function setCamera(h: SimHost, r: WorldRenderer, mode: CameraMode): void {
    if (mode === 'follow' && h.followId === null) {
      // Follow whatever is selected; otherwise the nearest animal to the camera.
      if (h.selectedId !== null) h.followId = h.selectedId;
      else h.followId = nearestAnimalTo(r, h);
    }
    r.rig.setMode(mode, h.world, h.followId);
    hud.setCameraMode(mode);
  }

  function nearestAnimalTo(r: WorldRenderer, h: SimHost): number | null {
    const c = h.world.creatures;
    let best: number | null = null;
    let bestDist = Infinity;
    for (let i = 0; i < c.capacity; i++) {
      if (!c.alive[i]) continue;
      const d = Math.hypot(c.x[i] - r.rig.focus.x, c.y[i] - r.rig.focus.z);
      if (d < bestDist) {
        bestDist = d;
        best = c.id[i];
      }
    }
    return best;
  }

  function toggleDocumentary(): void {
    current.documentary = !current.documentary;
    hud.setDocumentary(current.documentary);
    if (current.documentary) {
      const world = current.world;
      const stat = world.census.ordered().find((s) => (world.census.get(s.key)?.count ?? 0) > 0);
      current.say(
        `Observing ${world.name}. Day ${world.clock.day}, ${world.climate.state}. ${stat ? `${stat.count} ${stat.name.toLowerCase()} recorded.` : ''}`,
        stat?.key ?? '',
      );
    }
  }

  /* ---------------------------------------------------------------- */
  /* Pointer + keyboard                                               */
  /* ---------------------------------------------------------------- */

  const canvas = renderer.canvas;
  let hover: { x: number; y: number } | null = null;
  let dragging: 'orbit' | 'pan' | 'tool' | null = null;
  let lastX = 0;
  let lastY = 0;
  let moved = 0;
  let brushAt: { x: number; y: number; valid: boolean } | null = null;

  function ndc(ev: { clientX: number; clientY: number }): { x: number; y: number } {
    const rect = canvas.getBoundingClientRect();
    return { x: ((ev.clientX - rect.left) / rect.width) * 2 - 1, y: -(((ev.clientY - rect.top) / rect.height) * 2 - 1) };
  }

  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  // Held movement keys, applied smoothly in the frame loop rather than in steps
  // per keypress: flying should feel continuous, not notched.
  const held = new Set<string>();

  canvas.addEventListener('pointerdown', (ev) => {
    canvas.setPointerCapture(ev.pointerId);
    lastX = ev.clientX;
    lastY = ev.clientY;
    moved = 0;
    // Right button, middle button or Shift pans; anything else orbits, unless a
    // sandbox tool is armed, in which case it paints.
    const wantsPan = ev.button === 2 || ev.button === 1 || ev.shiftKey;
    dragging = wantsPan ? 'pan' : current.tool === 'inspect' || ev.button === 0 ? 'orbit' : 'tool';
    if (!wantsPan && current.tool !== 'inspect') {
      dragging = 'tool';
    }
    canvas.style.cursor = dragging === 'pan' ? 'grabbing' : dragging === 'orbit' ? 'move' : 'crosshair';
    if (dragging === 'tool' && current.tool !== 'inspect') {
      const p = renderer!.screenToGround(ndc(ev).x, ndc(ev).y, current.world);
      if (p) brushAt = { x: p.x, y: p.z, valid: true };
    }
  });
  canvas.addEventListener('pointermove', (ev) => {
    const dx = ev.clientX - lastX;
    const dy = ev.clientY - lastY;
    moved += Math.abs(dx) + Math.abs(dy);
    const panning = (ev.buttons & 4) !== 0 || (ev.buttons & 2) !== 0 || ev.shiftKey || ev.button === 1;
    if (dragging === 'pan' || panning) {
      renderer!.rig.pan(dx, dy, current.world);
    } else if (ev.buttons & 1) {
      if (dragging === 'tool') {
        const p = renderer!.screenToGround(ndc(ev).x, ndc(ev).y, current.world);
        if (p) brushAt = { x: p.x, y: p.z, valid: true };
      } else {
        renderer!.rig.orbit(dx, dy);
      }
    }
    lastX = ev.clientX;
    lastY = ev.clientY;
    // Cursor readout: what is under the pointer.
    if (panels.panelsHidden === false && ev.buttons === 0) {
      const p = renderer!.screenToGround(ndc(ev).x, ndc(ev).y, current.world);
      if (p) hover = { x: p.x, y: p.z };
    }
  });
  canvas.addEventListener('pointerup', (ev) => {
    canvas.releasePointerCapture(ev.pointerId);
    const wasDragging = moved > 4;
    const tool = current.tool;
    if ((dragging === 'tool' || dragging === null) && !wasDragging) {
      const p = renderer!.screenToGround(ndc(ev).x, ndc(ev).y, current.world);
      if (p) {
        if (tool === 'inspect') {
          const id = renderer!.pickOrganism(ndc(ev).x, ndc(ev).y, current.world);
          if (id !== null) {
            current.select(id);
            panels.setTab('organism');
            hud.toast(`Opened the file of ${SPECIES_NAME(current, id)}.`);
          } else {
            current.select(null);
          }
        } else {
          const result = current.applyTool(p.x, p.z, hud.brushRadius, { strength: hud.brushStrength });
          if (result) hud.toast(result);
          renderer!.terrainChanged();
        }
      }
    } else if (dragging === 'tool' && wasDragging && tool !== 'inspect' && brushAt) {
      const result = current.applyTool(brushAt.x, brushAt.y, hud.brushRadius, { strength: hud.brushStrength });
      if (result) hud.toast(result);
      renderer!.terrainChanged();
    }
    brushAt = null;
    dragging = null;
    canvas.style.cursor = current.tool === 'inspect' ? 'grab' : 'crosshair';
  });

  // Double-clicking an animal selects it and starts following it, which is the
  // fastest way to go from a wide view to one life story.
  canvas.addEventListener('dblclick', (ev) => {
    const id = renderer!.pickOrganism(ndc(ev).x, ndc(ev).y, current.world);
    if (id === null) return;
    current.select(id);
    current.follow(id);
    setCamera(current, renderer!, 'follow');
    panels.setTab('organism');
    hud.toast(`Following ${SPECIES_NAME(current, id)}.`);
  });
  canvas.addEventListener(
    'wheel',
    (ev) => {
      ev.preventDefault();
      // Three orders of magnitude of zoom in one gesture: a coarse step for
      // whole-landscape moves, fine when a modifier is held.
      const fine = ev.shiftKey ? 0.25 : ev.ctrlKey ? 2.4 : 1;
      renderer!.rig.zoom(ev.deltaY * 0.0025 * fine, current.world);
    },
    { passive: false },
  );

  // Touch: one finger orbits, two fingers pinch to zoom.
  let pinchStart = 0;
  canvas.addEventListener(
    'touchstart',
    (ev) => {
      if (ev.touches.length === 2) pinchStart = Math.hypot(ev.touches[0].clientX - ev.touches[1].clientX, ev.touches[0].clientY - ev.touches[1].clientY);
    },
    { passive: true },
  );
  canvas.addEventListener(
    'touchmove',
    (ev) => {
      if (ev.touches.length === 2 && pinchStart > 0) {
        const d = Math.hypot(ev.touches[0].clientX - ev.touches[1].clientX, ev.touches[0].clientY - ev.touches[1].clientY);
        renderer!.rig.zoom((pinchStart - d) * 0.004, current.world);
        pinchStart = d;
        ev.preventDefault();
      }
    },
    { passive: false },
  );

  window.addEventListener('keydown', (ev) => {
    if (hud.modalOpen) {
      if (ev.key === 'Escape') hud.closeModal();
      return;
    }
    const target = ev.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA')) return;
    // Flight keys are held, not tapped, so they are tracked rather than acted on.
    if (FLIGHT_KEYS.has(ev.key)) {
      held.add(ev.key);
      ev.preventDefault();
      return;
    }
    switch (ev.key) {
      case ' ':
        ev.preventDefault();
        current.togglePause();
        break;
      case '1':
      case '2':
      case '3':
      case '4':
      case '5':
      case '6':
      case '7': {
        const idx = Number(ev.key);
        const speeds = [1, 2, 5, 10, 25, 50, 100];
        current.setSpeed(speeds[idx - 1]);
        break;
      }
      case 'j':
        current.jump(ev.shiftKey ? 'week' : 'day');
        break;
      case 'J':
        current.jump('month');
        break;
      case 'f':
      case 'F':
        setCamera(current, renderer!, 'free');
        break;
      case 'g':
      case 'G':
        setCamera(current, renderer!, 'follow');
        break;
      case 'c':
      case 'C':
        setCamera(current, renderer!, 'cinematic');
        break;
      case 'o':
      case 'O':
        setCamera(current, renderer!, 'overhead');
        break;
      case 'v':
      case 'V':
        setCamera(current, renderer!, 'organism');
        break;
      case 'p':
      case 'P': {
        const order: ScaleLevel[] = ['planet', 'region', 'local', 'organism', 'micro'];
        const next = order[(order.indexOf(lastScale) + 1) % order.length];
        lastScale = next;
        renderer!.setScale(next, current.world);
        hud.setScale(next);
        break;
      }
      case 'd':
      case 'D':
        toggleDocumentary();
        break;
      case 'l':
      case 'L':
        void showLibrary();
        break;
      case 'Tab':
        ev.preventDefault();
        panels.togglePanels();
        break;
      case '?':
      case '/':
        hud.showHelp();
        break;
      case 'Escape':
        current.select(null);
        current.follow(null);
        break;
      default:
        break;
    }
  });

  /** Keys that fly the camera while held. */
  const FLIGHT_KEYS = new Set(['w', 'a', 's', 'd', 'q', 'e', 'r', 'f', 'W', 'A', 'S', 'D', 'Q', 'E', 'R', 'F', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);

  window.addEventListener('keyup', (ev) => {
    held.delete(ev.key);
  });
  // Releasing focus must not leave the camera flying forever.
  window.addEventListener('blur', () => held.clear());

  let lastScale: ScaleLevel = 'region';

  // First interaction starts audio (browser policy).
  const startAudio = () => {
    void ambience.start().then(() => {
      if (current.settings.musicVolume > 0.01) ambience.setVolumes(current.settings.masterVolume, current.settings.ambienceVolume, current.settings.musicVolume);
    });
    window.removeEventListener('pointerdown', startAudio);
    window.removeEventListener('keydown', startAudio);
  };
  window.addEventListener('pointerdown', startAudio);
  window.addEventListener('keydown', startAudio);

  window.addEventListener('resize', () => {
    renderer?.resize();
    overlay.resize();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) ambience.suspend();
    else ambience.resume();
  });
  window.addEventListener('beforeunload', () => {
    if (current.settings.autosave) void current.save();
  });

  /* ---------------------------------------------------------------- */
  /* Frame loop                                                       */
  /* ---------------------------------------------------------------- */

  let last = performance.now();
  let booted = false;

  let frameErrors = 0;

  function frame(now: number): void {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    const r = renderer as WorldRenderer;
    const world = current.world;

    try {
      frameBody(now, dt, r, world);
    } catch (err) {
      // A single bad frame must never stop the world from living.
      frameErrors++;
      if (frameErrors <= 3) console.error('[frame]', err);
      else if (frameErrors === 4) console.error('[frame] further frame errors suppressed');
    }
    requestAnimationFrame(frame);
  }

  function frameBody(now: number, dt: number, r: WorldRenderer, world: World): void {
    // Camera flight: held keys move the rig every frame, scaled by the frame
    // time so the speed is the same at 30 fps and 144 fps.
    if (held.size) {
      const fwd = (held.has('w') || held.has('W') || held.has('ArrowUp') ? 1 : 0) - (held.has('s') || held.has('S') || held.has('ArrowDown') ? 1 : 0);
      const side = (held.has('d') || held.has('D') || held.has('ArrowRight') ? 1 : 0) - (held.has('a') || held.has('A') || held.has('ArrowLeft') ? 1 : 0);
      const turn = (held.has('e') || held.has('E') ? 1 : 0) - (held.has('q') || held.has('Q') ? 1 : 0);
      const tilt = (held.has('f') || held.has('F') ? 1 : 0) - (held.has('r') || held.has('R') ? 1 : 0);
      const boost = 1;
      if (fwd || side) r.rig.moveInput(fwd * boost, side * boost, world, dt);
      if (turn || tilt) r.rig.orbit(-turn * dt * 0.55, tilt * dt * 0.45);
    }
    current.frame(dt, now);
    r.selectedId = current.selectedId;
    r.update(world, dt);
    overlay.update(
      world,
      r,
      {
        selectedId: current.selectedId,
        followId: current.followId,
        brush: brushAt ? { ...brushAt, radius: hud.brushRadius } : hover && current.tool !== 'inspect' ? { x: hover.x, y: hover.y, radius: hud.brushRadius, valid: true } : null,
        showLabels: current.settings.showLabels,
        documentaries: current.documentary,
      },
      dt,
    );
    r.render();
    hud.update(r);
    panels.update(dt, r.stats.fps);
    ambience.update(world, r.rig.camera.position.x, r.rig.camera.position.z, dt);

    if (!booted) {
      booted = true;
      hideBoot();
      hud.toast(`Welcome to ${world.name}. Click any animal to open its file.`);
    }
  }

  function hideBoot(): void {
    const boot = document.getElementById('boot');
    if (!boot) return;
    boot.setAttribute('aria-hidden', 'true');
    boot.style.opacity = '0';
    setTimeout(() => boot.remove(), 420);
  }

  // Expose a tiny debug surface for the automated verification harness.
  (window as unknown as Record<string, unknown>).__planet = {
    world: () => current.world,
    host: () => current,
    renderer: () => renderer,
    stats: () => ({ ...renderer!.stats, sim: current.world.stats, clock: current.world.clock }),
    step: (minutes: number) => current.world.advance(minutes, 4000),
    speciesIndex,
    version: 1,
  };

  bootStep('first light…', 0.95);
  requestAnimationFrame(frame);
  void clamp;
  void QUALITY_PRESETS;
  void app;
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function SPECIES_NAME(host: SimHost, id: number): string {
  const slot = host.world.creatures.findByLivingId(id);
  if (slot < 0) return 'that animal';
  const sp = (host.world.creatures.species(slot) as unknown as { name?: string }) ?? null;
  return sp?.name ?? 'that animal';
}

void main().catch((err) => {
  console.error(err);
  const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
  const sub = document.getElementById('boot-sub');
  if (sub) sub.textContent = `Could not start: ${detail} (during: ${bootStage})`;
  document.body.dataset.bootError = detail;
  document.body.dataset.bootStage = bootStage;
});
