/** Minimal Prometheus text-format metrics (counters, histograms and callback gauges). */

type Labels = Record<string, string>;

function labelKey(labels: Labels): string {
  const keys = Object.keys(labels).sort();
  if (keys.length === 0) return '';
  return `{${keys.map((k) => `${k}="${String(labels[k]).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`).join(',')}}`;
}

class Counter {
  readonly values = new Map<string, number>();
  readonly name: string;
  readonly help: string;
  constructor(name: string, help: string) {
    this.name = name;
    this.help = help;
  }
  inc(labels: Labels = {}, by = 1): void {
    const k = labelKey(labels);
    this.values.set(k, (this.values.get(k) ?? 0) + by);
  }
  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    for (const [k, v] of this.values) lines.push(`${this.name}${k} ${v}`);
    return lines.join('\n');
  }
}

class Histogram {
  private readonly series = new Map<string, { labels: Labels; counts: number[]; sum: number; count: number }>();
  readonly name: string;
  readonly help: string;
  readonly buckets: number[];
  constructor(name: string, help: string, buckets: number[]) {
    this.name = name;
    this.help = help;
    this.buckets = buckets;
  }
  observe(value: number, labels: Labels = {}): void {
    const k = labelKey(labels);
    let s = this.series.get(k);
    if (!s) {
      s = { labels, counts: this.buckets.map(() => 0), sum: 0, count: 0 };
      this.series.set(k, s);
    }
    this.buckets.forEach((b, i) => {
      if (value <= b) s!.counts[i]!++;
    });
    s.sum += value;
    s.count++;
  }
  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const s of this.series.values()) {
      this.buckets.forEach((b, i) => lines.push(`${this.name}_bucket${labelKey({ ...s.labels, le: String(b) })} ${s.counts[i]}`));
      lines.push(`${this.name}_bucket${labelKey({ ...s.labels, le: '+Inf' })} ${s.count}`);
      lines.push(`${this.name}_sum${labelKey(s.labels)} ${s.sum}`);
      lines.push(`${this.name}_count${labelKey(s.labels)} ${s.count}`);
    }
    return lines.join('\n');
  }
}

export class Metrics {
  readonly httpRequests = new Counter('resolver_http_requests_total', 'HTTP requests by route and status');
  readonly resolutions = new Counter('resolver_resolutions_total', 'Resolution outcomes by shortener and result code');
  readonly cacheHits = new Counter('resolver_cache_hits_total', 'Resolutions served from the result cache');
  readonly duration = new Histogram(
    'resolver_resolution_duration_seconds',
    'Resolution duration',
    [1, 2.5, 5, 10, 20, 30, 60, 90, 120, 180],
  );
  private readonly gauges: Array<{ name: string; help: string; fn: () => number }> = [];

  gauge(name: string, help: string, fn: () => number): void {
    this.gauges.push({ name, help, fn });
  }

  render(): string {
    const parts = [this.httpRequests.render(), this.resolutions.render(), this.cacheHits.render(), this.duration.render()];
    for (const g of this.gauges) {
      let v = 0;
      try {
        v = g.fn();
      } catch {
        v = Number.NaN;
      }
      parts.push(`# HELP ${g.name} ${g.help}\n# TYPE ${g.name} gauge\n${g.name} ${v}`);
    }
    return `${parts.join('\n')}\n`;
  }
}
