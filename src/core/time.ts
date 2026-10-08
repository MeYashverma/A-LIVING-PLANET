import { TIME } from './config';

export const SEASON_NAMES = ['Spring', 'Summer', 'Autumn', 'Winter'] as const;
export type SeasonName = (typeof SEASON_NAMES)[number];

/**
 * The world clock. All simulation time is expressed in in-game minutes since
 * the world began; days, seasons and years are derived from that.
 */
export class WorldClock {
  /** In-game minutes elapsed since year 1, day 1, 00:00. */
  minutes = 0;
  /** Index into TIME.speedSteps. 0 = paused. */
  speedIndex = 1;
  playRequested = true;

  constructor(startDay = 1) {
    // A world opens mid-morning in spring: daylight to look around in, and the
    // growing season ahead of it.
    this.minutes = (startDay - 1) * TIME.minutesPerDay + 9 * 60;
  }

  get speed(): number {
    return TIME.speedSteps[this.speedIndex] as number;
  }

  get paused(): boolean {
    return this.speedIndex === 0 || !this.playRequested;
  }

  setSpeedIndex(i: number): void {
    this.speedIndex = Math.max(0, Math.min(TIME.speedSteps.length - 1, i));
    if (this.speedIndex > 0) this.playRequested = true;
  }

  /** 1-based day counter since world creation. */
  get day(): number {
    return Math.floor(this.minutes / TIME.minutesPerDay) + 1;
  }

  get dayIndex(): number {
    return this.day - 1;
  }

  /** 1-based year. */
  get year(): number {
    return Math.floor(this.dayIndex / TIME.daysPerYear) + 1;
  }

  get dayOfYear(): number {
    return this.dayIndex % TIME.daysPerYear;
  }

  /** 0..1 progress through the current day. */
  get dayFraction(): number {
    const m = this.minutes % TIME.minutesPerDay;
    return m / TIME.minutesPerDay;
  }

  /** Decimal hour of day, 0..24. */
  get hour(): number {
    return (this.minutes % TIME.minutesPerDay) / 60;
  }

  get minuteOfHour(): number {
    return Math.floor(this.minutes % 60);
  }

  get seasonIndex(): number {
    return Math.floor(this.dayOfYear / TIME.daysPerSeason) % TIME.seasons;
  }

  get season(): SeasonName {
    return SEASON_NAMES[this.seasonIndex];
  }

  /** 0..1 position within the current season (used for lerped climate curves). */
  get seasonFraction(): number {
    return (this.dayOfYear % TIME.daysPerSeason) / TIME.daysPerSeason;
  }

  /** Fraction of the year elapsed, 0..1. */
  get yearFraction(): number {
    return this.dayOfYear / TIME.daysPerYear;
  }

  /**
   * Solar declination factor -1..1: -1 at midwinter, +1 at midsummer.
   * Seasons are laid out Spring -> Summer -> Autumn -> Winter from day one,
   * so the peak sits a quarter of the way in (midsummer) and the trough three
   * quarters in (midwinter).
   */
  get seasonalSolar(): number {
    return Math.sin((this.yearFraction - 0.125) * Math.PI * 2);
  }

  /** 0 at sunrise, 1 at solar noon — used for insolation. */
  get solarElevation(): number {
    // Simple sinusoid: night between 19:00 and 05:00 (plus seasonal skew).
    const h = this.hour;
    const skew = this.seasonSeasonalDayLengthBias();
    const sunrise = 6 - skew;
    const sunset = 18 + skew;
    if (h < sunrise || h > sunset) return 0;
    const t = (h - sunrise) / (sunset - sunrise);
    return Math.sin(t * Math.PI);
  }

  /** Shortens/lengthens the day with the seasons (hours of extra daylight). */
  seasonSeasonalDayLengthBias(): number {
    return this.seasonalSolar * 1.6;
  }

  get isNight(): boolean {
    return this.solarElevation <= 0.02;
  }

  /** Advance by wall-clock seconds at the current speed. */
  update(realSeconds: number): number {
    if (this.paused) return 0;
    const minutesPerRealSecond = (TIME.minutesPerDay / TIME.realSecondsPerDayAt1x) * this.speed;
    const advanced = realSeconds * minutesPerRealSecond;
    this.minutes += advanced;
    return advanced;
  }

  /** Advance by an exact number of in-game minutes (fast-forward, offline catch-up). */
  advanceMinutes(m: number): void {
    this.minutes += m;
  }

  advanceDays(d: number): void {
    this.minutes += d * TIME.minutesPerDay;
  }

  format(): string {
    const h = Math.floor(this.hour);
    const m = Math.floor((this.hour - h) * 60);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }

  formatDate(): string {
    return `Year ${this.year} · Day ${this.dayOfYear + 1} · ${this.season}`;
  }

  save(): number {
    return this.minutes;
  }

  load(v: number): void {
    this.minutes = v;
  }
}
