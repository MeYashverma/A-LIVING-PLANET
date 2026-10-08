/** Minimal typed event bus — the seam between simulation and interface. */

export type Handler<T> = (payload: T) => void;

export class EventBus<Map extends object> {
  private handlers = new Map<keyof Map, Set<Handler<never>>>();

  on<K extends keyof Map>(event: K, handler: Handler<Map[K]>): () => void {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(handler as Handler<never>);
    return () => this.off(event, handler);
  }

  off<K extends keyof Map>(event: K, handler: Handler<Map[K]>): void {
    this.handlers.get(event)?.delete(handler as Handler<never>);
  }

  emit<K extends keyof Map>(event: K, payload: Map[K]): void {
    const set = this.handlers.get(event);
    if (!set) return;
    for (const h of set) {
      try {
        (h as Handler<Map[K]>)(payload);
      } catch (err) {
        // A broken listener must never take the simulation down with it.
        console.error(`[events] handler for "${String(event)}" threw`, err);
      }
    }
  }

  clear(): void {
    this.handlers.clear();
  }
}

/** Notable things the world does, surfaced as history + notification toasts. */
export interface WorldEvent {
  id: number;
  day: number;
  year: number;
  minuteOfDay: number;
  /** Coarse category used for iconography and filtering. */
  kind:
    | 'birth'
    | 'death'
    | 'hunt'
    | 'disaster'
    | 'climate'
    | 'evolution'
    | 'population'
    | 'discovery'
    | 'human'
    | 'colony'
    | 'disease'
    | 'recovery';
  title: string;
  detail?: string;
  /** 0 = trivia, 1 = notable, 2 = major, 3 = historic. */
  weight: number;
  speciesId?: string;
  organismId?: number;
  /** World position, 0,0 when the event has no location. */
  x?: number;
  y?: number;
  /** For the documentary feed: subject of the story beat. */
  subject?: string;
}

export interface AppEvents {
  'world:created': { seed: string; name: string };
  'world:loaded': { name: string; summary?: OfflineSummary };
  'world:disposed': undefined;
  'time:tick': { minute: number };
  'time:day': { day: number; year: number };
  'season:change': { season: number; year: number };
  'weather:change': { state: string; intensity: number };
  'event:notable': WorldEvent;
  'organism:selected': { id: number | null };
  'organism:died': { id: number; speciesId: string; cause: string; x: number; y: number };
  'organism:born': { id: number; speciesId: string; parents: number[] };
  'species:extinct': { speciesId: string; day: number };
  'discovery:new': { key: string; title: string; detail: string };
  'camera:mode': { mode: string };
  'ui:toast': { text: string; kind?: string; ms?: number };
  'sim:error': { message: string; where: string };
  'settings:changed': Partial<Settings>;
}

export interface OfflineSummary {
  elapsedDays: number;
  fromDay: number;
  toDay: number;
  births: number;
  deaths: number;
  speciesChanges: { id: string; name: string; from: number; to: number }[];
  events: WorldEvent[];
  generationsAdvanced: number;
  mutations: string[];
  biomeChanges: string[];
}

export interface Settings {
  quality: 'low' | 'medium' | 'high' | 'ultra';
  masterVolume: number;
  ambienceVolume: number;
  musicVolume: number;
  reducedMotion: boolean;
  uiScale: number;
  showLabels: boolean;
  autoRotateCinematic: boolean;
  colorblindSafe: boolean;
  highContrast: boolean;
  particleDensity: number;
  showTrails: boolean;
  documentaryCaptions: boolean;
  autosave: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  quality: 'high',
  masterVolume: 0.7,
  ambienceVolume: 0.8,
  musicVolume: 0.35,
  reducedMotion: false,
  uiScale: 1,
  showLabels: true,
  autoRotateCinematic: true,
  colorblindSafe: false,
  highContrast: false,
  particleDensity: 1,
  showTrails: true,
  documentaryCaptions: true,
  autosave: true,
};
