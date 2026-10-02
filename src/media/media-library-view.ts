import type { MediaRecord, Project } from '../domain/models';
import { formatDuration } from './media-service';

export interface MediaLibraryActions {
  select(record: MediaRecord): void;
  remove(record: MediaRecord): void;
}

export class MediaLibraryView {
  private readonly grid = document.querySelector<HTMLElement>('#media-grid')!;
  private readonly emptyState = document.querySelector<HTMLElement>('#empty-library')!;
  private readonly count = document.querySelector<HTMLElement>('#media-count')!;
  private readonly projectCount = document.querySelector<HTMLElement>('#project-item-count')!;
  private readonly search = document.querySelector<HTMLInputElement>('#media-search')!;
  private readonly sort = document.querySelector<HTMLSelectElement>('#sort-media')!;
  private readonly viewToggle = document.querySelector<HTMLButtonElement>('#toggle-media-view')!;
  private records: MediaRecord[] = [];
  private project: Project | null = null;
  private isListView = false;
  private readonly objectUrls = new Map<string, string>();

  constructor(private readonly actions: MediaLibraryActions) {
    this.search.addEventListener('input', () => this.render());
    this.sort.addEventListener('change', () => this.render());
    this.viewToggle.addEventListener('click', () => {
      this.isListView = !this.isListView;
      this.viewToggle.textContent = this.isListView ? 'Grid' : 'List';
      this.viewToggle.setAttribute('aria-label', `Switch to ${this.isListView ? 'grid' : 'list'} view`);
      this.render();
    });
  }

  update(project: Project, records: MediaRecord[]): void {
    const activeIds = new Set(records.map((record) => record.id));
    this.objectUrls.forEach((url, id) => {
      if (!activeIds.has(id)) { URL.revokeObjectURL(url); this.objectUrls.delete(id); }
    });
    this.project = project;
    this.records = records;
    this.count.textContent = String(records.length).padStart(2, '0');
    this.projectCount.textContent = `${records.length} ${records.length === 1 ? 'file' : 'files'}`;
    this.render();
  }

  dispose(): void {
    this.objectUrls.forEach((url) => URL.revokeObjectURL(url));
    this.objectUrls.clear();
  }

  private render(): void {
    const query = this.search.value.trim().toLocaleLowerCase();
    const filtered = this.records.filter((record) => record.name.toLocaleLowerCase().includes(query));
    if (this.sort.value === 'name') filtered.sort((a, b) => a.name.localeCompare(b.name));
    if (this.sort.value === 'largest') filtered.sort((a, b) => b.size - a.size);
    if (this.sort.value === 'newest') filtered.sort((a, b) => b.importedAt - a.importedAt);
    this.grid.classList.toggle('list-view', this.isListView);
    this.grid.replaceChildren(...filtered.map((record) => this.createCard(record)));
    this.emptyState.hidden = this.records.length > 0;
    if (this.records.length > 0 && filtered.length === 0) {
      this.emptyState.hidden = false;
      this.emptyState.querySelector('strong')!.textContent = 'No matching media';
      this.emptyState.querySelector('p')!.textContent = 'Try another search, or clear the search field.';
    } else {
      this.emptyState.querySelector('strong')!.textContent = 'No media in this project yet';
      this.emptyState.querySelector('p')!.textContent = 'Choose files or drop them above. Original files are kept in this browser.';
    }
    document.querySelector('#canvas-project-name')!.textContent = this.project?.name ?? '';
  }

  private createCard(record: MediaRecord): HTMLElement {
    const card = document.createElement('article');
    card.className = `media-card${this.project?.selectedMediaId === record.id ? ' selected' : ''}`;
    const select = document.createElement('button');
    select.type = 'button'; select.className = 'media-card-select';
    select.setAttribute('aria-label', `Preview ${record.name}`);
    if (record.thumbnail) {
      const image = document.createElement('img');
      image.src = this.urlFor(record.id, record.thumbnail); image.alt = '';
      select.append(image);
    } else {
      const placeholder = document.createElement('span'); placeholder.className = 'media-placeholder';
      placeholder.textContent = record.kind === 'video' ? '▶' : '▧'; select.append(placeholder);
    }
    if (record.kind === 'video' && record.duration !== null) {
      const duration = document.createElement('span'); duration.className = 'media-duration'; duration.textContent = formatDuration(record.duration); select.append(duration);
    }
    const title = document.createElement('span'); title.className = 'media-card-title'; title.textContent = record.name;
    const detail = document.createElement('small'); detail.textContent = `${formatSize(record.size)}${record.width && record.height ? ` · ${record.width}×${record.height}` : ''}`;
    select.append(title, detail);
    select.addEventListener('click', () => this.actions.select(record));
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'media-remove'; remove.textContent = '×'; remove.setAttribute('aria-label', `Remove ${record.name} from project`);
    remove.addEventListener('click', () => this.actions.remove(record));
    card.append(select, remove);
    return card;
  }

  private urlFor(id: string, blob: Blob): string {
    const existing = this.objectUrls.get(id);
    if (existing) return existing;
    const url = URL.createObjectURL(blob); this.objectUrls.set(id, url); return url;
  }
}

function formatSize(bytes: number): string {
  return bytes < 1024 ** 2 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}
