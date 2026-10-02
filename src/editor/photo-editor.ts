import { createPhotoEdit, type CanvasOverlay, type PhotoEdit, type Project, type TextOverlay } from '../domain/models';
import type { MediaRecord } from '../domain/models';
import { CanvasRenderer, dimensionsForRatio } from './canvas-renderer';

type ProjectChange = (project: Project) => void;

export class PhotoEditor {
  private readonly renderer = new CanvasRenderer();
  private readonly canvas = document.querySelector<HTMLCanvasElement>('#editor-canvas')!;
  private readonly panel = document.querySelector<HTMLElement>('#photo-panel')!;
  private project: Project | null = null;
  private record: MediaRecord | null = null;
  private undoStack: PhotoEdit[] = [];
  private redoStack: PhotoEdit[] = [];
  private gestureStart: PhotoEdit | null = null;
  private selectedOverlayId: string | null = null;
  private renderGeneration = 0;
  private draggingOverlayId: string | null = null;
  private dragMode: 'move' | 'resize' = 'move';
  private dragStart: { x: number; y: number; overlay: CanvasOverlay } | null = null;

  constructor(private readonly onChange: ProjectChange, private readonly onNotice: (message: string) => void, private readonly onFailure: (message: string) => void) {
    this.bindControls();
  }

  async setContext(project: Project, record: MediaRecord | null): Promise<void> {
    this.renderGeneration += 1;
    if (this.record && this.record.id !== record?.id) this.renderer.release(this.record.id);
    this.project = project; this.record = record; this.undoStack = []; this.redoStack = []; this.gestureStart = null; this.selectedOverlayId = null;
    this.panel.classList.toggle('no-selection', !record);
    this.updateControls();
    if (record) await this.render();
    else this.drawEmptyState();
  }

  setActive(active: boolean): void { this.panel.hidden = !active; }

  async render(): Promise<void> {
    if (!this.project || !this.record) { this.drawEmptyState(); return; }
    const generation = ++this.renderGeneration;
    const project = this.project; const record = this.record;
    try {
      const size = dimensionsForRatio(project.canvasRatio, 720);
      const result = await this.renderer.render(record, project, size.width, size.height);
      if (generation !== this.renderGeneration) { if (record.id !== this.record?.id) this.renderer.release(record.id); return; }
      this.canvas.width = result.width; this.canvas.height = result.height;
      const context = this.canvas.getContext('2d');
      if (!context) throw new Error('Could not draw the image preview.');
      context.drawImage(result, 0, 0);
      const selected = this.currentEdit().overlays.find((overlay) => overlay.id === this.selectedOverlayId);
      if (selected) this.drawLayerSelection(context, selected, result.width, result.height);
      this.canvas.setAttribute('aria-label', `Edited preview of ${record.name}`);
    } catch (error) { this.onFailure(message(error, 'Could not render this media.')); }
  }

  dispose(): void { this.renderer.dispose(); }

  async renderExport(width: number, height: number): Promise<HTMLCanvasElement> {
    if (!this.project || !this.record) throw new Error('Choose a photo before exporting an image.');
    if (this.record.kind !== 'image') throw new Error('Still image export is available for photos. Choose video export for clips.');
    return this.renderer.render(this.record, this.project, width, height);
  }

  getRenderer(): CanvasRenderer { return this.renderer; }

  private bindControls(): void {
    this.canvas.tabIndex = 0;
    this.canvas.addEventListener('pointerdown', (event) => this.beginOverlayDrag(event));
    this.canvas.addEventListener('pointermove', (event) => this.moveOverlayWithPointer(event));
    this.canvas.addEventListener('pointerup', () => this.finishOverlayDrag());
    this.canvas.addEventListener('pointercancel', () => this.finishOverlayDrag());
    this.canvas.addEventListener('keydown', (event) => {
      if (!this.selectedOverlayId || !['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) return;
      event.preventDefault();
      const amount = event.shiftKey ? 0.05 : 0.01;
      this.moveSelectedLayer(event.key === 'ArrowLeft' ? -amount : event.key === 'ArrowRight' ? amount : 0, event.key === 'ArrowUp' ? -amount : event.key === 'ArrowDown' ? amount : 0);
    });
    const ranges = ['brightness', 'contrast', 'saturation', 'temperature', 'highlights', 'shadows', 'zoom'] as const;
    ranges.forEach((key) => {
      const input = document.querySelector<HTMLInputElement>(`#photo-${key}`)!;
      input.addEventListener('pointerdown', () => this.beginGesture());
      input.addEventListener('keydown', (event) => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) this.beginGesture(); });
      input.addEventListener('input', () => {
        const value = Number(input.value);
        this.patchEdit({ [key]: value } as Partial<PhotoEdit>, true);
        document.querySelector(`#${key}-value`)!.textContent = key === 'zoom' ? `${value.toFixed(1)}×` : `${value > 0 ? '+' : ''}${value}`;
      });
      input.addEventListener('change', () => this.endGesture());
    });
    document.querySelector('#rotate-button')?.addEventListener('click', () => {
      const current = this.currentEdit(); this.commitEdit({ rotation: ((current.rotation + 90) % 360) as PhotoEdit['rotation'] });
    });
    document.querySelector('#flip-button')?.addEventListener('click', () => this.commitEdit({ flipHorizontal: !this.currentEdit().flipHorizontal }));
    document.querySelector('#fit-mode')?.addEventListener('click', () => this.commitEdit({ fit: this.currentEdit().fit === 'cover' ? 'contain' : 'cover' }));
    document.querySelector('#reset-photo-button')?.addEventListener('click', () => this.commitEdit(createPhotoEdit()));
    document.querySelector('#undo-photo-button')?.addEventListener('click', () => this.undo());
    document.querySelector('#redo-photo-button')?.addEventListener('click', () => this.redo());
    document.querySelector('#add-overlay-button')?.addEventListener('click', () => this.addOverlay());
    document.querySelector('#add-shape-button')?.addEventListener('click', () => this.addShape());
    const backgroundColor = document.querySelector<HTMLInputElement>('#background-color')!;
    backgroundColor.addEventListener('pointerdown', () => this.beginGesture());
    backgroundColor.addEventListener('keydown', () => this.beginGesture());
    backgroundColor.addEventListener('input', (event) => this.patchEdit({ backgroundColor: (event.currentTarget as HTMLInputElement).value }, true));
    backgroundColor.addEventListener('change', () => this.endGesture());
    document.querySelector<HTMLSelectElement>('#photo-look')?.addEventListener('change', (event) => this.commitEdit({ look: (event.currentTarget as HTMLSelectElement).value as PhotoEdit['look'] }));
    const filterAmount = document.querySelector<HTMLInputElement>('#filter-amount')!;
    filterAmount.addEventListener('pointerdown', () => this.beginGesture());
    filterAmount.addEventListener('keydown', () => this.beginGesture());
    filterAmount.addEventListener('input', () => { const amount = Number(filterAmount.value); document.querySelector('#filter-amount-value')!.textContent = `${amount}%`; this.patchEdit({ filterAmount: amount }, true); });
    filterAmount.addEventListener('change', () => this.endGesture());
    const opacity = document.querySelector<HTMLInputElement>('#layer-opacity')!;
    opacity.addEventListener('pointerdown', () => this.beginGesture());
    opacity.addEventListener('keydown', () => this.beginGesture());
    opacity.addEventListener('input', () => { this.patchSelected({ opacity: Number(opacity.value) / 100 }, true); document.querySelector('#layer-opacity-value')!.textContent = `${opacity.value}%`; });
    opacity.addEventListener('change', () => this.endGesture());
    const size = document.querySelector<HTMLInputElement>('#layer-size')!;
    size.addEventListener('pointerdown', () => this.beginGesture());
    size.addEventListener('keydown', () => this.beginGesture());
    size.addEventListener('input', () => { this.patchSelected({ size: Number(size.value) }, true); document.querySelector('#layer-size-value')!.textContent = size.value; });
    size.addEventListener('change', () => this.endGesture());
    const layerColor = document.querySelector<HTMLInputElement>('#layer-color')!;
    layerColor.addEventListener('pointerdown', () => this.beginGesture());
    layerColor.addEventListener('keydown', () => this.beginGesture());
    layerColor.addEventListener('input', (event) => this.patchSelected({ color: (event.currentTarget as HTMLInputElement).value }, true));
    layerColor.addEventListener('change', () => this.endGesture());
    const layerText = document.querySelector<HTMLInputElement>('#layer-text')!;
    layerText.addEventListener('focus', () => this.beginGesture());
    layerText.addEventListener('input', (event) => this.patchSelected({ text: (event.currentTarget as HTMLInputElement).value }, true));
    layerText.addEventListener('change', () => this.endGesture());
    document.querySelector<HTMLSelectElement>('#layer-font')?.addEventListener('change', (event) => this.commitSelected({ font: (event.currentTarget as HTMLSelectElement).value as 'sans' | 'serif' | 'mono' }));
    document.querySelector<HTMLSelectElement>('#layer-align')?.addEventListener('change', (event) => this.commitSelected({ align: (event.currentTarget as HTMLSelectElement).value as 'left' | 'center' | 'right' }));
    document.querySelectorAll<HTMLButtonElement>('[data-layer-move]').forEach((button) => button.addEventListener('click', () => {
      const [x, y] = (button.dataset.layerMove ?? '0,0').split(',').map(Number); this.moveSelectedLayer(x, y);
    }));
    document.querySelectorAll<HTMLButtonElement>('[data-layer-size]').forEach((button) => button.addEventListener('click', () => this.resizeSelectedLayer(Number(button.dataset.layerSize))));
  }

  private currentEdit(): PhotoEdit {
    if (!this.project || !this.record) return createPhotoEdit();
    return this.project.photoEdits[this.record.id] ?? createPhotoEdit();
  }

  private beginGesture(): void { if (!this.gestureStart) this.gestureStart = structuredClone(this.currentEdit()); }

  private endGesture(): void {
    if (this.gestureStart) { this.pushUndo(this.gestureStart); this.gestureStart = null; this.redoStack = []; this.updateHistoryButtons(); }
  }

  private commitEdit(patch: Partial<PhotoEdit>): void {
    this.pushUndo(structuredClone(this.currentEdit()));
    this.redoStack = [];
    this.patchEdit(patch, true);
  }

  private patchEdit(patch: Partial<PhotoEdit>, render: boolean): void {
    if (!this.project || !this.record) return;
    const updated = { ...this.currentEdit(), ...patch };
    this.project = { ...this.project, photoEdits: { ...this.project.photoEdits, [this.record.id]: updated }, updatedAt: Date.now() };
    this.onChange(this.project); this.updateControls();
    if (render) void this.render();
  }

  private pushUndo(edit: PhotoEdit): void {
    this.undoStack.push(edit);
    if (this.undoStack.length > 40) this.undoStack.shift();
  }

  private undo(): void {
    if (!this.undoStack.length) return;
    this.redoStack.push(structuredClone(this.currentEdit()));
    const edit = this.undoStack.pop()!;
    this.patchEdit(edit, true); this.updateHistoryButtons();
  }

  private redo(): void {
    if (!this.redoStack.length) return;
    this.pushUndo(structuredClone(this.currentEdit()));
    const edit = this.redoStack.pop()!;
    this.patchEdit(edit, true); this.updateHistoryButtons();
  }

  private addOverlay(): void {
    if (!this.record) { this.onNotice('Choose media before adding a text layer.'); return; }
    const input = document.querySelector<HTMLInputElement>('#overlay-text-input')!;
    const text = input.value.trim();
    if (!text) { input.focus(); this.onNotice('Type some text before adding a layer.'); return; }
    const overlay: TextOverlay = { kind: 'text', id: crypto.randomUUID(), text, x: 0.5, y: 0.76, size: 56, color: document.querySelector<HTMLInputElement>('#overlay-color')!.value, opacity: 1, font: 'sans', align: 'center' };
    this.commitEdit({ overlays: [...this.currentEdit().overlays, overlay] });
    this.selectedOverlayId = overlay.id; this.updateControls();
    input.value = '';
  }

  private addShape(): void {
    if (!this.record) { this.onNotice('Choose media before adding a shape.'); return; }
    const shape = document.querySelector<HTMLSelectElement>('#overlay-shape')!.value as Extract<CanvasOverlay, { kind: 'shape' }>['shape'];
    const overlay: CanvasOverlay = { kind: 'shape', id: crypto.randomUUID(), shape, x: 0.5, y: 0.5, width: 0.35, height: 0.12, color: document.querySelector<HTMLInputElement>('#overlay-color')!.value, opacity: 0.8 };
    this.commitEdit({ overlays: [...this.currentEdit().overlays, overlay] });
    this.selectedOverlayId = overlay.id; this.updateControls();
  }

  private updateControls(): void {
    const edit = this.currentEdit();
    (['brightness', 'contrast', 'saturation', 'temperature', 'highlights', 'shadows', 'zoom'] as const).forEach((key) => {
      const input = document.querySelector<HTMLInputElement>(`#photo-${key}`)!;
      input.value = String(edit[key]);
      document.querySelector(`#${key}-value`)!.textContent = key === 'zoom' ? `${edit[key].toFixed(1)}×` : `${edit[key] > 0 ? '+' : ''}${edit[key]}`;
    });
    document.querySelector('#rotate-button')!.setAttribute('aria-label', `Rotate photo, current rotation ${edit.rotation} degrees`);
    document.querySelector('#fit-mode')!.textContent = edit.fit === 'cover' ? 'Fill frame' : 'Fit entire image';
    document.querySelector<HTMLInputElement>('#background-color')!.value = edit.backgroundColor || '#171916';
    document.querySelector<HTMLSelectElement>('#photo-look')!.value = edit.look;
    document.querySelector<HTMLInputElement>('#filter-amount')!.value = String(edit.filterAmount);
    document.querySelector('#filter-amount-value')!.textContent = `${edit.filterAmount}%`;
    document.querySelector('#flip-button')!.setAttribute('aria-pressed', String(edit.flipHorizontal));
    const ratio = document.querySelector<HTMLSelectElement>('#canvas-ratio');
    if (ratio && this.project) ratio.value = this.project.canvasRatio;
    this.renderOverlays(edit.overlays); this.updateLayerProperties(edit.overlays.find((overlay) => overlay.id === this.selectedOverlayId) ?? null); this.updateHistoryButtons();
  }

  private updateLayerProperties(layer: CanvasOverlay | null): void {
    const fieldset = document.querySelector<HTMLFieldSetElement>('#layer-properties')!;
    fieldset.disabled = !layer;
    document.querySelectorAll<HTMLElement>('.text-layer-property').forEach((element) => { element.hidden = layer?.kind !== 'text'; });
    document.querySelector<HTMLElement>('.layer-property-size')!.hidden = layer?.kind !== 'text';
    if (!layer) return;
    document.querySelector<HTMLInputElement>('#layer-color')!.value = layer.color;
    document.querySelector<HTMLInputElement>('#layer-opacity')!.value = String(Math.round(layer.opacity * 100));
    document.querySelector('#layer-opacity-value')!.textContent = `${Math.round(layer.opacity * 100)}%`;
    if (layer.kind === 'text') {
      document.querySelector<HTMLInputElement>('#layer-text')!.value = layer.text;
      document.querySelector<HTMLSelectElement>('#layer-font')!.value = layer.font;
      document.querySelector<HTMLSelectElement>('#layer-align')!.value = layer.align;
      document.querySelector<HTMLInputElement>('#layer-size')!.value = String(layer.size);
      document.querySelector('#layer-size-value')!.textContent = String(layer.size);
    }
  }

  private patchSelected(patch: Partial<CanvasOverlay>, render: boolean): void {
    if (!this.selectedOverlayId) return;
    const overlays = this.currentEdit().overlays.map((layer) => layer.id === this.selectedOverlayId ? { ...layer, ...patch } as CanvasOverlay : layer);
    this.patchEdit({ overlays }, render);
  }

  private commitSelected(patch: Partial<CanvasOverlay>): void {
    if (!this.selectedOverlayId) return;
    this.pushUndo(structuredClone(this.currentEdit())); this.redoStack = [];
    this.patchSelected(patch, true);
  }

  private renderOverlays(overlays: CanvasOverlay[]): void {
    const list = document.querySelector<HTMLElement>('#overlay-list')!;
    list.replaceChildren();
    overlays.forEach((overlay, index) => {
      const row = document.createElement('div'); row.className = 'overlay-row';
      const label = document.createElement('button'); label.type = 'button'; label.className = 'overlay-select';
      const layerName = overlay.kind === 'text' ? overlay.text || 'Empty caption' : `${overlay.shape} object`;
      label.textContent = layerName;
      label.title = layerName; label.setAttribute('aria-label', `Select ${layerName}. Focus the canvas and use arrow keys to move it.`); label.setAttribute('aria-pressed', String(this.selectedOverlayId === overlay.id));
      label.addEventListener('click', () => { this.selectedOverlayId = overlay.id; this.updateControls(); this.canvas.focus({ preventScroll: true }); void this.render(); });
      const up = actionButton('↑', `Move ${layerName} forward`, () => this.moveOverlay(index, 1)); up.disabled = index === overlays.length - 1;
      const down = actionButton('↓', `Move ${layerName} backward`, () => this.moveOverlay(index, -1)); down.disabled = index === 0;
      const remove = actionButton('×', `Remove ${label.textContent}`, () => {
        this.commitEdit({ overlays: this.currentEdit().overlays.filter((item) => item.id !== overlay.id) });
        if (this.selectedOverlayId === overlay.id) this.selectedOverlayId = null;
        this.updateControls();
      });
      row.append(label, up, down, remove); list.append(row);
    });
  }

  private moveOverlay(index: number, delta: number): void {
    const layers = [...this.currentEdit().overlays];
    const target = index + delta; if (target < 0 || target >= layers.length) return;
    [layers[index], layers[target]] = [layers[target], layers[index]];
    this.commitEdit({ overlays: layers });
  }

  private moveSelectedLayer(dx: number, dy: number): void {
    const layers = this.currentEdit().overlays;
    const layer = layers.find((item) => item.id === this.selectedOverlayId);
    if (!layer) { this.onNotice('Select a text or shape layer first.'); return; }
    const changed = layers.map((item) => item.id === layer.id ? { ...item, x: Math.max(0.05, Math.min(0.95, item.x + dx)), y: Math.max(0.05, Math.min(0.95, item.y + dy)) } : item);
    this.commitEdit({ overlays: changed });
  }

  private beginOverlayDrag(event: PointerEvent): void {
    if (!this.project || !this.record || event.button !== 0) return;
    const point = this.canvasPoint(event);
    const layers = this.currentEdit().overlays;
    const selected = layers.find((layer) => layer.id === this.selectedOverlayId);
    const resizeHit = selected ? this.nearResizeHandle(selected, point.x, point.y) : false;
    const hit = resizeHit ? selected : [...layers].reverse().find((layer) => this.hitOverlay(layer, point.x, point.y));
    if (!hit) { this.selectedOverlayId = null; this.renderOverlays(layers); return; }
    this.selectedOverlayId = hit.id;
    this.draggingOverlayId = hit.id;
    this.dragMode = resizeHit ? 'resize' : 'move';
    this.dragStart = { ...point, overlay: structuredClone(hit) };
    this.beginGesture();
    this.canvas.setPointerCapture(event.pointerId);
    this.canvas.focus({ preventScroll: true });
    this.canvas.classList.add('dragging-layer');
    this.canvas.classList.toggle('resizing-layer', resizeHit);
    this.renderOverlays(layers);
    event.preventDefault();
  }

  private moveOverlayWithPointer(event: PointerEvent): void {
    if (!this.draggingOverlayId || !this.project) return;
    const point = this.canvasPoint(event);
    const overlays = this.currentEdit().overlays.map((layer) => {
      if (layer.id !== this.draggingOverlayId || !this.dragStart) return layer;
      if (this.dragMode === 'move') return { ...layer, x: clamp(0.02, 0.98, point.x), y: clamp(0.02, 0.98, point.y) } as CanvasOverlay;
      const start = this.dragStart.overlay;
      if (start.kind === 'text' && layer.kind === 'text') return { ...layer, size: clamp(16, 240, start.size + (point.y - this.dragStart.y) * 1200) };
      if (start.kind === 'shape' && layer.kind === 'shape') {
        const left = start.x - start.width / 2; const top = start.y - start.height / 2;
        const width = clamp(0.04, 0.95, point.x - left); const height = clamp(0.03, 0.85, point.y - top);
        return { ...layer, width, height, x: left + width / 2, y: top + height / 2 };
      }
      return layer;
    });
    this.patchEdit({ overlays }, false);
    event.preventDefault();
  }

  private finishOverlayDrag(): void {
    if (!this.draggingOverlayId) return;
    this.draggingOverlayId = null;
    this.dragStart = null;
    this.canvas.classList.remove('dragging-layer');
    this.canvas.classList.remove('resizing-layer');
    this.endGesture();
  }

  private canvasPoint(event: PointerEvent): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    return { x: (event.clientX - rect.left) / rect.width, y: (event.clientY - rect.top) / rect.height };
  }

  private hitOverlay(overlay: CanvasOverlay, x: number, y: number): boolean {
    if (overlay.kind === 'shape') return Math.abs(x - overlay.x) <= overlay.width / 2 && Math.abs(y - overlay.y) <= overlay.height / 2;
    const fontSize = overlay.size / 1200;
    const roughWidth = Math.min(0.82, Math.max(0.08, overlay.text.length * fontSize * 0.56));
    const lineCount = Math.max(1, Math.ceil(overlay.text.length * fontSize * 0.56 / 0.82));
    const roughHeight = Math.max(0.045, fontSize * 1.25 * lineCount);
    return Math.abs(x - overlay.x) <= roughWidth / 2 && Math.abs(y - overlay.y) <= roughHeight / 2;
  }

  private nearResizeHandle(overlay: CanvasOverlay, x: number, y: number): boolean {
    const rect = this.canvas.getBoundingClientRect();
    const toleranceX = Math.max(0.018, 10 / rect.width); const toleranceY = Math.max(0.018, 10 / rect.height);
    const bounds = this.overlayBounds(overlay);
    return Math.abs(x - bounds.right) <= toleranceX && Math.abs(y - bounds.bottom) <= toleranceY;
  }

  private overlayBounds(overlay: CanvasOverlay): { left: number; right: number; top: number; bottom: number } {
    const width = overlay.kind === 'shape' ? overlay.width : Math.min(0.82, Math.max(0.08, overlay.text.length * overlay.size / 1200 * 0.56));
    const height = overlay.kind === 'shape' ? overlay.height : Math.max(0.045, overlay.size / 1200 * 1.3);
    return { left: overlay.x - width / 2, right: overlay.x + width / 2, top: overlay.y - height / 2, bottom: overlay.y + height / 2 };
  }

  private drawLayerSelection(context: CanvasRenderingContext2D, overlay: CanvasOverlay, width: number, height: number): void {
    const boxWidth = overlay.kind === 'shape' ? overlay.width * width : Math.min(width * 0.82, Math.max(width * 0.08, overlay.text.length * overlay.size * height / 1200 * 0.56));
    const boxHeight = overlay.kind === 'shape' ? overlay.height * height : Math.max(height * 0.045, overlay.size * height / 1200 * 1.3);
    context.save(); context.strokeStyle = '#fff'; context.lineWidth = Math.max(1, width / 360); context.setLineDash([6, 4]); context.shadowColor = '#111'; context.shadowBlur = 4;
    context.strokeRect(overlay.x * width - boxWidth / 2, overlay.y * height - boxHeight / 2, boxWidth, boxHeight);
    context.setLineDash([]); context.fillStyle = '#fff'; context.strokeStyle = '#27301f';
    [[-1,-1],[1,-1],[-1,1],[1,1]].forEach(([dx,dy]) => { const x = overlay.x * width + dx * boxWidth / 2; const y = overlay.y * height + dy * boxHeight / 2; context.beginPath(); context.arc(x, y, Math.max(4, width / 100), 0, Math.PI * 2); context.fill(); context.stroke(); }); context.restore();
  }

  private resizeSelectedLayer(delta: number): void {
    const layers = this.currentEdit().overlays;
    const layer = layers.find((item) => item.id === this.selectedOverlayId);
    if (!layer) { this.onNotice('Select a text or shape layer first.'); return; }
    const changed = layers.map((item) => {
      if (item.id !== layer.id) return item;
      return item.kind === 'text' ? { ...item, size: Math.max(16, Math.min(240, item.size + delta)) } : { ...item, width: Math.max(0.04, Math.min(0.95, item.width + delta / 400)), height: Math.max(0.03, Math.min(0.85, item.height + delta / 400)) };
    });
    this.commitEdit({ overlays: changed });
  }

  private updateHistoryButtons(): void {
    const undo = document.querySelector<HTMLButtonElement>('#undo-photo-button');
    const redo = document.querySelector<HTMLButtonElement>('#redo-photo-button');
    if (undo) undo.disabled = !this.undoStack.length;
    if (redo) redo.disabled = !this.redoStack.length;
  }

  private drawEmptyState(): void {
    const context = this.canvas.getContext('2d');
    if (!context) return;
    this.canvas.width = 540; this.canvas.height = 720;
    context.fillStyle = '#dcdcd4'; context.fillRect(0, 0, this.canvas.width, this.canvas.height);
    context.fillStyle = '#6f7168'; context.font = '20px system-ui'; context.textAlign = 'center'; context.fillText('Add a photo to start editing', 270, 360);
  }
}

function actionButton(text: string, label: string, action: () => void): HTMLButtonElement {
  const button = document.createElement('button'); button.type = 'button'; button.textContent = text; button.setAttribute('aria-label', label); button.addEventListener('click', action); return button;
}

function message(error: unknown, fallback: string): string { return error instanceof Error ? error.message : fallback; }
function clamp(min: number, max: number, value: number): number { return Math.max(min, Math.min(max, value)); }
