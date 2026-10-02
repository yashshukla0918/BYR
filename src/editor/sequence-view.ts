import type { MediaRecord, Project, SequenceClip } from '../domain/models';

export class SequenceView {
  private readonly root = document.querySelector<HTMLElement>('#sequence-items')!;
  private readonly summary = document.querySelector<HTMLElement>('#sequence-summary')!;
  private project: Project | null = null;
  private media: MediaRecord[] = [];
  constructor(private readonly onChange: (project: Project) => void, private readonly onSelect: (record: MediaRecord) => void) {}

  update(project: Project, records: MediaRecord[]): void { this.project = project; this.media = records; this.render(); }

  private render(): void {
    if (!this.project) return;
    this.root.replaceChildren();
    this.project.sequence.forEach((clip, index) => {
      const record = this.media.find((item) => item.id === clip.mediaId);
      if (!record) return;
      const row = document.createElement('article'); row.className = 'sequence-item';
      const title = document.createElement('button'); title.type = 'button'; title.className = 'sequence-title'; title.textContent = `${index + 1}. ${record.name}`; title.title = `Select ${record.name}`;
      title.addEventListener('click', () => this.onSelect(record));
      const durationLabel = document.createElement('label'); durationLabel.className = 'sequence-duration'; durationLabel.textContent = 'sec';
      const duration = document.createElement('input'); duration.type = 'number'; duration.min = '0.5'; duration.max = '120'; duration.step = '0.5'; duration.value = String(clip.duration); duration.setAttribute('aria-label', `Duration for ${record.name} in seconds`);
      duration.addEventListener('change', () => this.patchClip(clip.id, { duration: Math.max(0.5, Math.min(120, Number(duration.value) || 3)) }));
      durationLabel.prepend(duration);
      const up = button('↑', `Move ${record.name} earlier`, () => this.moveClip(index, -1)); up.disabled = index === 0;
      const down = button('↓', `Move ${record.name} later`, () => this.moveClip(index, 1)); down.disabled = index === this.project!.sequence.length - 1;
      const remove = button('×', `Remove ${record.name} from sequence`, () => this.setSequence(this.project!.sequence.filter((item) => item.id !== clip.id)));
      row.append(title, durationLabel, up, down, remove); this.root.append(row);
    });
    const total = this.project.sequence.reduce((sum, clip) => sum + clip.duration, 0);
    this.summary.textContent = `${this.project.sequence.length} clips · ${total.toFixed(1)} sec`;
  }

  private moveClip(index: number, delta: number): void {
    if (!this.project) return;
    const clips = [...this.project.sequence]; const target = index + delta;
    if (target < 0 || target >= clips.length) return;
    [clips[index], clips[target]] = [clips[target], clips[index]];
    this.setSequence(clips);
  }

  private patchClip(id: string, patch: Partial<SequenceClip>): void {
    if (!this.project) return;
    this.setSequence(this.project.sequence.map((clip) => clip.id === id ? { ...clip, ...patch } : clip));
  }

  private setSequence(sequence: SequenceClip[]): void {
    if (!this.project) return;
    this.project = { ...this.project, sequence, updatedAt: Date.now() };
    this.onChange(this.project); this.render();
  }
}

function button(text: string, label: string, action: () => void): HTMLButtonElement {
  const control = document.createElement('button'); control.type = 'button'; control.textContent = text; control.setAttribute('aria-label', label); control.addEventListener('click', action); return control;
}
