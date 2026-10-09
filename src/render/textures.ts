import * as THREE from 'three';

/**
 * Every texture the renderer binds, in one place.
 *
 * The rules that matter are enforced here rather than at each call site:
 * albedo maps are sRGB, normal and roughness maps are raw data and must never
 * be colour-converted, everything repeats with mipmaps and full anisotropy, and
 * nothing is uploaded until it has actually decoded.
 *
 * Assets live in `public/assets` and are addressed relatively so the build works
 * from a subdirectory (GitHub Pages) as well as from the site root.
 */
export interface MaterialSet {
  color: THREE.Texture;
  normal: THREE.Texture;
  rough: THREE.Texture;
}

export type GroundKey = 'grass' | 'sand' | 'rock' | 'snow' | 'dirt' | 'moss' | 'cliff' | 'gravel';
export type BarkKey = 'pine' | 'oak' | 'birch';
export type LeafKey = 'broadleaf' | 'conifer' | 'willow';
export type CardKey = 'grass_lush' | 'grass_dry' | 'reed';

/**
 * Relative to the document, so the build works from a subdirectory (a GitHub
 * Pages project site) exactly as it does from the site root.
 */
function url(rel: string): string {
  const base = document.baseURI || window.location.href;
  return new URL(rel, base).href;
}

export class TextureLibrary {
  readonly ground = {} as Record<GroundKey, MaterialSet>;
  readonly bark = {} as Record<BarkKey, MaterialSet>;
  readonly leaf = {} as Record<LeafKey, THREE.Texture>;
  readonly card = {} as Record<CardKey, THREE.Texture>;
  waterNormal: THREE.Texture | null = null;
  foam: THREE.Texture | null = null;
  /** 0..1 while loading, used by the loading screen. */
  progress = 0;
  ready = false;

  private loader = new THREE.TextureLoader();
  private maxAnisotropy = 1;

  constructor(renderer?: THREE.WebGLRenderer) {
    if (renderer) this.maxAnisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  }

  /** Fetch every map. Resolves when all of them are decoded and configured. */
  async load(onProgress?: (p: number) => void): Promise<void> {
    const jobs: Promise<void>[] = [];
    const total = 8 * 3 + 3 * 3 + 3 + 3 + 2;
    let done = 0;
    const tick = () => {
      done++;
      this.progress = done / total;
      onProgress?.(this.progress);
    };

    const loadOne = (rel: string, srgb: boolean, repeat = 1): Promise<THREE.Texture> =>
      new Promise((resolve, reject) => {
        this.loader.load(
          url(rel),
          (tex) => {
            tex.wrapS = THREE.RepeatWrapping;
            tex.wrapT = THREE.RepeatWrapping;
            tex.anisotropy = this.maxAnisotropy;
            tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
            tex.repeat.set(repeat, repeat);
            tex.needsUpdate = true;
            tick();
            resolve(tex);
          },
          undefined,
          () => {
            // A missing map must not take the whole world down: fall back to a
            // flat 1x1 of the right kind so the material still renders.
            const fallback = new THREE.DataTexture(
              new Uint8Array(srgb ? [128, 128, 128, 255] : [128, 128, 255, 255]),
              1,
              1,
              THREE.RGBAFormat,
            );
            fallback.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
            fallback.needsUpdate = true;
            console.warn('[assets] missing texture, using flat fallback:', rel);
            tick();
            resolve(fallback);
          },
        );
      });

    const materialSet = async (key: string, folder: string, repeat: number, ext = 'jpg'): Promise<MaterialSet> => ({
      color: await loadOne(`${folder}/${key}_color.${ext}`, true, repeat),
      normal: await loadOne(`${folder}/${key}_normal.${ext}`, false, repeat),
      rough: await loadOne(`${folder}/${key}_rough.${ext}`, false, repeat),
    });

    const groundKeys: GroundKey[] = ['grass', 'sand', 'rock', 'snow', 'dirt', 'moss', 'cliff', 'gravel'];
    for (const key of groundKeys) {
      jobs.push(
        materialSet(key, 'assets/ground', 1).then((set) => {
          this.ground[key] = set;
        }),
      );
    }

    const barkKeys: BarkKey[] = ['pine', 'oak', 'birch'];
    for (const key of barkKeys) {
      jobs.push(
        materialSet(`bark_${key}`, 'assets/gen', 1, 'png').then((set) => {
          this.bark[key] = set;
        }),
      );
    }

    const leafKeys: LeafKey[] = ['broadleaf', 'conifer', 'willow'];
    for (const key of leafKeys) {
      jobs.push(
        loadOne(`assets/gen/leaf_${key}_color.png`, true).then((t) => {
          this.leaf[key] = t;
          return undefined;
        }),
      );
    }

    const cardKeys: CardKey[] = ['grass_lush', 'grass_dry', 'reed'];
    for (const key of cardKeys) {
      jobs.push(
        loadOne(`assets/gen/${key}_color.png`, true).then((t) => {
          this.card[key] = t;
          return undefined;
        }),
      );
    }

    jobs.push(
      loadOne('assets/gen/water_normal.png', false).then((t) => {
        this.waterNormal = t;
        return undefined;
      }),
    );
    jobs.push(
      loadOne('assets/gen/foam.png', true).then((t) => {
        this.foam = t;
        return undefined;
      }),
    );

    await Promise.all(jobs);
    this.ready = true;
    this.progress = 1;
  }

  /** Release GPU memory when a world is closed. */
  dispose(): void {
    for (const set of Object.values(this.ground)) {
      set.color.dispose();
      set.normal.dispose();
      set.rough.dispose();
    }
    for (const set of Object.values(this.bark)) {
      set.color.dispose();
      set.normal.dispose();
      set.rough.dispose();
    }
    for (const t of Object.values(this.leaf)) t.dispose();
    for (const t of Object.values(this.card)) t.dispose();
    this.waterNormal?.dispose();
    this.foam?.dispose();
  }
}
