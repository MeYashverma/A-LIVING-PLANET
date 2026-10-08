/**
 * Ambience: a small Web Audio engine that synthesises the sound of the place
 * you are looking at from the simulation's own numbers — wind from wind speed,
 * rain from rain intensity, water near lakes and rivers, insect stridulation
 * from real insect biomass, bird and mammal calls from nearby activity, fire
 * crackle from fire heat. No samples, nothing to download, and the music bed is
 * a sparse optional pad that is off by default.
 */
import { clamp, clamp01, lerp, TAU } from '../core/math';
import { SPECIES } from '../life/species';
import { Action } from '../life/organism';
import type { World } from '../world/world';

interface Voice {
  stop(): void;
}

export class Ambience {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private ambienceBus: GainNode | null = null;
  private musicBus: GainNode | null = null;
  private windGain: GainNode | null = null;
  private rainGain: GainNode | null = null;
  private waterGain: GainNode | null = null;
  private fireGain: GainNode | null = null;
  private insectGain: GainNode | null = null;
  private musicVoices: Voice[] = [];
  private started = false;
  private lastCall = 0;
  private lastSleep = 0;
  private noiseBuffer: AudioBuffer | null = null;
  masterVolume = 0.7;
  ambienceVolume = 0.8;
  musicVolume = 0;

  get running(): boolean {
    return this.started;
  }

  /** Must be called from a user gesture; browsers require it. */
  async start(): Promise<void> {
    if (this.started) return;
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    this.ctx = new Ctor();
    await this.ctx.resume();
    const ctx = this.ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.masterVolume;
    this.master.connect(ctx.destination);
    this.ambienceBus = ctx.createGain();
    this.ambienceBus.gain.value = this.ambienceVolume;
    this.ambienceBus.connect(this.master);
    this.musicBus = ctx.createGain();
    this.musicBus.gain.value = this.musicVolume;
    this.musicBus.connect(this.master);

    this.noiseBuffer = this.makeNoise(ctx);

    // Wind: filtered noise, cutoff and gain follow the weather.
    this.windGain = this.loopNoise(180, 'lowpass', 0.0);
    // Rain: brighter noise band.
    this.rainGain = this.loopNoise(4200, 'highpass', 0.0);
    // Water: low rumble with a slow LFO.
    this.waterGain = this.loopNoise(620, 'bandpass', 0.0);
    // Fire: crackle comes from amplitude jitter on a bandpassed noise loop.
    this.fireGain = this.loopNoise(1800, 'bandpass', 0.0);
    // Insects: a narrow band that reads as summer stridulation.
    this.insectGain = this.loopNoise(5200, 'bandpass', 0.0);
    this.started = true;
  }

  setVolumes(master: number, ambience: number, music: number): void {
    this.masterVolume = clamp01(master);
    this.ambienceVolume = clamp01(ambience);
    this.musicVolume = clamp01(music);
    if (this.master) this.master.gain.value = this.masterVolume;
    if (this.ambienceBus) this.ambienceBus.gain.value = this.ambienceVolume;
    if (this.musicBus) this.musicBus.gain.value = this.musicVolume;
    if (this.musicVolume <= 0.001) this.stopMusic();
    else if (this.started && !this.musicVoices.length) this.startMusic();
  }

  suspend(): void {
    void this.ctx?.suspend();
  }

  resume(): void {
    void this.ctx?.resume();
  }

  /** Update the bed from the world, at the camera's position. */
  update(world: World, cameraX: number, cameraY: number, dt: number): void {
    if (!this.started || !this.ctx) return;
    const climate = world.climate;
    const hour = world.clock.hour;
    const t = this.ctx.currentTime;

    // Wind: audible above ~1.5 m/s, louder in storms and on ridges.
    const ridge = clamp01(world.terrain.elevationAtWorld(cameraX, cameraY) - 0.35);
    const wind = clamp01((climate.windSpeed - 1.2) / 12) * (0.5 + ridge * 0.9);
    this.set(this.windGain, t, wind * 0.16);

    const rain = clamp01(climate.rainIntensityAt(cameraX, cameraY) / 1.6);
    this.set(this.rainGain, t, rain * 0.12);

    const wet = world.terrain.waterAtWorld(cameraX, cameraY);
    const reach = world.hydrology.waterReach(cameraX, cameraY);
    const nearWater = reach ? clamp01(1 - reach.distance / 90) : 0;
    this.set(this.waterGain, t, clamp01(Math.max(wet * 0.6, nearWater) * 0.1));

    const fire = clamp01(world.fire.heat.sample(world.terrain.worldToCellX(cameraX), world.terrain.worldToCellY(cameraY)));
    this.set(this.fireGain, t, fire * 0.22);

    // Insects: warm, still, daytime, and there have to be insects.
    const insect = world.aggregates.insectActivityAt(cameraX, cameraY);
    const day = clamp01(Math.sin((hour / 24) * TAU - Math.PI / 2) * 0.5 + 0.5);
    const season = world.clock.seasonIndex === 3 ? 0.15 : 1;
    this.set(this.insectGain, t, clamp01(insect) * day * season * clamp01(1 - rain) * 0.045);

    // Creature calls: distance-attenuated, throttled so the world does not
    // become a bird orchestra.
    this.lastCall -= dt;
    if (this.lastCall <= 0 && this.ctx.state === 'running') {
      this.lastCall = 0.7 + Math.random() * 1.6;
      this.maybeCall(world, cameraX, cameraY, hour, rain);
    }
    void clamp;
    void lerp;
    void world;
  }

  private maybeCall(world: World, cameraX: number, cameraY: number, hour: number, rain: number): void {
    const c = world.creatures;
    const scratches = c.grid.queryRadius(cameraX, cameraY, 120, c.scratch);
    if (!scratches) return;
    const night = hour < 5.5 || hour > 20;
    let best = -1;
    let bestScore = 0;
    for (let i = 0; i < scratches; i++) {
      const slot = c.scratch[i];
      if (!c.alive[slot]) continue;
      const sp = SPECIES[c.speciesIdx[slot]];
      // Only animals that actually vocalise, and only when it matters.
      if (sp.locomotion === 'fish') continue;
      const active = sp.activity === 'nocturnal' ? night : sp.activity === 'diurnal' ? !night : true;
      if (!active) continue;
      const dist = Math.hypot(c.x[slot] - cameraX, c.y[slot] - cameraY);
      const action = c.action[slot] as Action;
      const urgency = 0.25 + c.fear[slot] * 0.6 + (action === Action.Flee ? 0.8 : 0) + (action === Action.Court ? 0.4 : 0);
      const score = (Math.min(sp.massKg, 400) / 400 + urgency) / (1 + dist / 40);
      if (score > bestScore) {
        bestScore = score;
        best = slot;
      }
    }
    if (best < 0 || bestScore < 0.09 || rain > 1.1) return;
    const slot = best;
    const sp = SPECIES[c.speciesIdx[slot]];
    const dist = Math.hypot(c.x[slot] - cameraX, c.y[slot] - cameraY);
    const gain = clamp01(1 - dist / 130) * 0.08;
    if (sp.locomotion === 'bird') this.birdCall(gain, sp.massKg);
    else if (sp.massKg > 60) this.lowCall(gain, sp.massKg, c.fear[slot] > 0.4);
    else this.mammalChirp(gain, sp.massKg);
  }

  /** A short filtered noise burst with a pitch envelope: a bird. */
  private birdCall(gain: number, mass: number): void {
    if (!this.ctx || !this.ambienceBus) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    osc.type = 'triangle';
    const base = lerp(2600, 1200, clamp01(mass / 5));
    const notes = 2 + Math.floor(Math.random() * 3);
    for (let i = 0; i < notes; i++) {
      const at = t + i * (0.07 + Math.random() * 0.05);
      osc.frequency.setValueAtTime(base * (0.9 + Math.random() * 0.4), at);
      osc.frequency.exponentialRampToValueAtTime(base * (0.6 + Math.random() * 0.5), at + 0.06);
    }
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(gain, t + 0.01);
    env.gain.exponentialRampToValueAtTime(0.0001, t + notes * 0.09 + 0.05);
    osc.connect(env).connect(this.ambienceBus);
    osc.start(t);
    osc.stop(t + notes * 0.09 + 0.12);
  }

  private mammalChirp(gain: number, mass: number): void {
    if (!this.ctx || !this.ambienceBus) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    const filter = ctx.createBiquadFilter();
    const env = ctx.createGain();
    const base = lerp(900, 320, clamp01(mass / 20));
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(base, t);
    osc.frequency.exponentialRampToValueAtTime(base * 1.6, t + 0.05);
    osc.frequency.exponentialRampToValueAtTime(base * 0.7, t + 0.16);
    filter.type = 'bandpass';
    filter.frequency.value = base * 1.4;
    filter.Q.value = 3;
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(gain, t + 0.015);
    env.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
    osc.connect(filter).connect(env).connect(this.ambienceBus);
    osc.start(t);
    osc.stop(t + 0.26);
  }

  /** A long, low call: a wolf howl, an elk bugle, a bison grunt. */
  private lowCall(gain: number, mass: number, alarmed: boolean): void {
    if (!this.ctx || !this.ambienceBus) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    const filter = ctx.createBiquadFilter();
    const base = lerp(200, 70, clamp01((mass - 60) / 400));
    osc.type = alarmed ? 'square' : 'sine';
    const dur = alarmed ? 0.4 : 1.2 + Math.random() * 0.8;
    osc.frequency.setValueAtTime(base * (alarmed ? 1.2 : 0.85), t);
    if (!alarmed) {
      osc.frequency.linearRampToValueAtTime(base * 1.15, t + dur * 0.3);
      osc.frequency.linearRampToValueAtTime(base * 0.8, t + dur);
    }
    filter.type = 'lowpass';
    filter.frequency.value = base * 6;
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(gain * (alarmed ? 1.2 : 1), t + 0.06);
    env.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(filter).connect(env).connect(this.ambienceBus);
    osc.start(t);
    osc.stop(t + dur + 0.1);
  }

  /* ------------------------------------------------------------------ */
  /* Music bed: sparse, slow, off unless the player turns it on.          */
  /* ------------------------------------------------------------------ */

  private startMusic(): void {
    if (!this.ctx || !this.musicBus || this.musicVoices.length) return;
    const ctx = this.ctx;
    const bus = this.musicBus;
    const root = 55; // A1
    const ratios = [1, 1.5, 2, 2.99];
    for (const [i, ratio] of ratios.entries()) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const filter = ctx.createBiquadFilter();
      osc.type = i % 2 === 0 ? 'sine' : 'triangle';
      osc.frequency.value = root * ratio * (1 + (Math.random() - 0.5) * 0.004);
      filter.type = 'lowpass';
      filter.frequency.value = 300 + i * 180;
      gain.gain.value = 0;
      const target = 0.05 / (i + 1.4);
      gain.gain.linearRampToValueAtTime(target, ctx.currentTime + 6 + i * 2);
      const lfo = ctx.createOscillator();
      const lfoGain = ctx.createGain();
      lfo.frequency.value = 0.03 + i * 0.017;
      lfoGain.gain.value = target * 0.5;
      lfo.connect(lfoGain).connect(gain.gain);
      lfo.start();
      osc.connect(filter).connect(gain).connect(bus);
      osc.start();
      this.musicVoices.push({
        stop: () => {
          try {
            gain.gain.cancelScheduledValues(ctx.currentTime);
            gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 3);
            osc.stop(ctx.currentTime + 3.2);
            lfo.stop(ctx.currentTime + 3.2);
          } catch {
            /* already stopped */
          }
        },
      });
    }
  }

  private stopMusic(): void {
    for (const v of this.musicVoices) v.stop();
    this.musicVoices = [];
  }

  /* ------------------------------------------------------------------ */
  /* Plumbing                                                            */
  /* ------------------------------------------------------------------ */

  private makeNoise(ctx: AudioContext): AudioBuffer {
    const seconds = 4;
    const buffer = ctx.createBuffer(1, ctx.sampleRate * seconds, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    let last = 0;
    for (let i = 0; i < data.length; i++) {
      // Pink-ish noise: a simple one-pole filter over white noise.
      const white = Math.random() * 2 - 1;
      last = last * 0.94 + white * 0.06;
      data[i] = white * 0.5 + last * 2.2;
    }
    return buffer;
  }

  private loopNoise(frequency: number, type: BiquadFilterType, gain: number): GainNode {
    const ctx = this.ctx as AudioContext;
    const bus = this.ambienceBus as GainNode;
    const source = ctx.createBufferSource();
    source.buffer = this.noiseBuffer;
    source.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = frequency;
    filter.Q.value = type === 'bandpass' ? 1.2 : 0.6;
    const g = ctx.createGain();
    g.gain.value = gain;
    source.connect(filter).connect(g).connect(bus);
    // Slow movement so the bed never sounds like a static hiss.
    const lfo = ctx.createOscillator();
    const lfoGain = ctx.createGain();
    lfo.frequency.value = 0.07 + Math.random() * 0.12;
    lfoGain.gain.value = Math.max(0.001, gain * 0.6 + 0.004);
    lfo.connect(lfoGain).connect(g.gain);
    lfo.start();
    source.start();
    return g;
  }

  private set(node: GainNode | null, time: number, value: number): void {
    if (!node) return;
    node.gain.setTargetAtTime(Math.max(0.0001, value), time, 1.4);
  }
}
