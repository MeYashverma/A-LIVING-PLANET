/**
 * Spatial hashing. A rebuildable linked grid keeps neighbour queries at O(k)
 * instead of O(n²) — the difference between a living world and a slideshow.
 */
export class LinkedGrid {
  readonly cellSize: number;
  readonly cols: number;
  readonly rows: number;
  private head: Int32Array;
  private next: Int32Array;
  private capacity: number;

  constructor(worldSize: number, cellSize: number, capacity: number) {
    this.cellSize = cellSize;
    this.cols = Math.max(1, Math.ceil(worldSize / cellSize));
    this.rows = this.cols;
    this.head = new Int32Array(this.cols * this.rows).fill(-1);
    this.capacity = capacity;
    this.next = new Int32Array(capacity).fill(-1);
  }

  ensureCapacity(capacity: number): void {
    if (capacity <= this.capacity) return;
    const n = new Int32Array(capacity).fill(-1);
    this.next = n;
    this.capacity = capacity;
  }

  clear(): void {
    this.head.fill(-1);
  }

  private cellOf(x: number, y: number): number {
    let cx = Math.floor(x / this.cellSize);
    let cy = Math.floor(y / this.cellSize);
    if (cx < 0) cx = 0;
    if (cy < 0) cy = 0;
    if (cx >= this.cols) cx = this.cols - 1;
    if (cy >= this.rows) cy = this.rows - 1;
    return cy * this.cols + cx;
  }

  insert(slot: number, x: number, y: number): void {
    const c = this.cellOf(x, y);
    this.next[slot] = this.head[c];
    this.head[c] = slot;
  }

  /**
   * Visit every slot within `radius` world units of (x,y).
   * Returns the number written into `out`.
   */
  queryRadius(x: number, y: number, radius: number, out: Int32Array): number {
    const r = radius;
    const minX = Math.max(0, Math.floor((x - r) / this.cellSize));
    const maxX = Math.min(this.cols - 1, Math.floor((x + r) / this.cellSize));
    const minY = Math.max(0, Math.floor((y - r) / this.cellSize));
    const maxY = Math.min(this.rows - 1, Math.floor((y + r) / this.cellSize));
    let n = 0;
    for (let cy = minY; cy <= maxY; cy++) {
      const row = cy * this.cols;
      for (let cx = minX; cx <= maxX; cx++) {
        let s = this.head[row + cx];
        while (s !== -1) {
          if (n < out.length) out[n++] = s;
          else return n;
          s = this.next[s];
        }
      }
    }
    return n;
  }

  /** Visit every occupied cell in a rectangle (used by the census/charts). */
  forEachCell(cb: (cellIndex: number, cx: number, cy: number) => void): void {
    for (let i = 0; i < this.head.length; i++) {
      if (this.head[i] !== -1) cb(i, i % this.cols, Math.floor(i / this.cols));
    }
  }

  /** Slots in a single cell (no radius). */
  queryCell(x: number, y: number, out: Int32Array): number {
    const c = this.cellOf(x, y);
    let s = this.head[c];
    let n = 0;
    while (s !== -1) {
      if (n < out.length) out[n++] = s;
      else break;
      s = this.next[s];
    }
    return n;
  }
}

/** A coarse density field used for census maps and aggregate interactions. */
export class DensityGrid {
  readonly size: number;
  readonly cellSize: number;
  readonly counts: Float32Array;
  readonly cols: number;

  constructor(worldSize: number, cellSize: number) {
    this.cellSize = cellSize;
    this.cols = Math.max(1, Math.ceil(worldSize / cellSize));
    this.size = this.cols;
    this.counts = new Float32Array(this.cols * this.cols);
  }

  clear(): void {
    this.counts.fill(0);
  }

  add(x: number, y: number, v: number): void {
    let cx = Math.floor((x + this.cols * this.cellSize * 0.5) / this.cellSize);
    let cy = Math.floor((y + this.cols * this.cellSize * 0.5) / this.cellSize);
    if (cx < 0) cx = 0;
    if (cy < 0) cy = 0;
    if (cx >= this.cols) cx = this.cols - 1;
    if (cy >= this.cols) cy = this.cols - 1;
    this.counts[cy * this.cols + cx] += v;
  }

  at(x: number, y: number): number {
    let cx = Math.floor((x + this.cols * this.cellSize * 0.5) / this.cellSize);
    let cy = Math.floor((y + this.cols * this.cellSize * 0.5) / this.cellSize);
    if (cx < 0) cx = 0;
    if (cy < 0) cy = 0;
    if (cx >= this.cols) cx = this.cols - 1;
    if (cy >= this.cols) cy = this.cols - 1;
    return this.counts[cy * this.cols + cx];
  }
}
