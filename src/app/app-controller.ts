import { createPhotoEdit, createProject, type MediaRecord, type Project } from '../domain/models';
import { MediaLibraryView } from '../media/media-library-view';
import { prepareMediaFiles } from '../media/media-service';
import { importProjectBundle, exportProjectBundle } from '../projects/project-bundle';
import { addMediaRecords, clearWorkspaceRecords, cloneProjectRecords, deleteProjectRecords, listProjectMedia, listProjects, removeMediaRecord, saveProject } from '../storage/database';
import { formatBytes, getStorageInfo } from '../storage/storage-info';
import { DialogService } from '../ui/dialog';
import { Toast } from '../ui/toast';
import { PhotoEditor } from '../editor/photo-editor';
import { SequenceView } from '../editor/sequence-view';
import { downloadBlob, estimateVideoBytes, exportSequenceVideo, exportStillImage, outputDimensions, safeOutputName, supportedVideoMime, type StillType } from '../export/export-service';
import { AppErrorBoundary } from '../errors/error-boundary';

export class AppController {
  private projects: Project[] = [];
  private activeProject: Project | null = null;
  private libraryRecords: MediaRecord[] = [];
  private saveTimer = 0;
  private exportAbort: AbortController | null = null;
  private readonly toast = new Toast(document.querySelector<HTMLElement>('#toast')!);
  private readonly dialog = new DialogService();
  private readonly library = new MediaLibraryView({ select: (record) => void this.selectMedia(record), remove: (record) => void this.removeMedia(record) });
  private readonly photoEditor = new PhotoEditor((project) => this.scheduleProjectSave(project), (message) => this.toast.show(message), (message) => this.reportEditorError(message));
  private readonly sequenceView = new SequenceView((project) => this.scheduleProjectSave(project), (record) => void this.selectMedia(record));
  private readonly boundary: AppErrorBoundary;

  constructor(boundary: AppErrorBoundary = new AppErrorBoundary()) { this.boundary = boundary; }

  async start(): Promise<void> {
    this.bindEvents();
    try {
      this.projects = await listProjects();
      this.activeProject = this.projects[0] ?? createProject('Untitled project');
      if (this.projects.length === 0) { await saveProject(this.activeProject); this.projects = [this.activeProject]; }
      await this.refreshActiveProject();
      await this.refreshStorageInfo();
      this.renderProjects();
      document.querySelector('#save-state')!.textContent = 'Saved locally';
    } catch (error) {
      this.toast.show(errorMessage(error, 'Could not open browser storage. Enable local site data and reload.'), 6000);
      document.querySelector('#save-state')!.textContent = 'Storage unavailable';
      this.boundary.capture(error, 'Could not open the local workspace.');
    }
  }

  private bindEvents(): void {
    const input = document.querySelector<HTMLInputElement>('#media-input')!;
    const folderInput = document.querySelector<HTMLInputElement>('#folder-input')!;
    const dropZone = document.querySelector<HTMLElement>('#drop-zone')!;
    input.addEventListener('change', () => { if (input.files) void this.importFiles(input.files); input.value = ''; });
    folderInput.addEventListener('change', () => { if (folderInput.files) void this.importFiles(folderInput.files); folderInput.value = ''; });
    dropZone.addEventListener('dragover', (event) => { event.preventDefault(); dropZone.classList.add('dragging'); });
    dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragging'));
    dropZone.addEventListener('drop', (event) => { event.preventDefault(); dropZone.classList.remove('dragging'); if (event.dataTransfer?.files) void this.importFiles(event.dataTransfer.files); });
    document.querySelector('#add-media-inline')?.addEventListener('click', () => input.click());
    document.querySelector('#sequence-add-selected')?.addEventListener('click', () => this.addSelectedToSequence());
    document.querySelector('#folder-button')?.addEventListener('click', () => folderInput.click());
    document.querySelector('#new-project-button')?.addEventListener('click', () => void this.createNewProject());
    document.querySelector('#new-project-shortcut')?.addEventListener('click', () => void this.createNewProject());
    document.querySelector('#rename-project-button')?.addEventListener('click', () => void this.renameProject());
    document.querySelector('#project-menu-button')?.addEventListener('click', () => this.toggleProjectMenu());
    document.querySelector('#project-menu')?.addEventListener('click', (event) => void this.handleProjectMenu(event));
    document.addEventListener('click', (event) => {
      const menu = document.querySelector<HTMLElement>('#project-menu')!;
      if (!menu.contains(event.target as Node) && !document.querySelector('#project-menu-button')!.contains(event.target as Node)) menu.hidden = true;
    });
    document.querySelector('#import-project-button')?.addEventListener('click', () => document.querySelector<HTMLInputElement>('#package-input')!.click());
    document.querySelector<HTMLInputElement>('#package-input')?.addEventListener('change', (event) => {
      const inputElement = event.currentTarget as HTMLInputElement;
      if (inputElement.files?.[0]) void this.importPackage(inputElement.files[0]);
      inputElement.value = '';
    });
    document.querySelector('#play-button')?.addEventListener('click', () => this.togglePreviewPlayback());
    document.querySelector('#help-button')?.addEventListener('click', () => void this.showPrivacyInfo());
    document.querySelector('#privacy-button')?.addEventListener('click', () => void this.showPrivacyInfo());
    document.querySelector('#storage-details-button')?.addEventListener('click', () => void this.showStorageInfo());
    this.bindEditorEvents();
  }

  private bindEditorEvents(): void {
    document.querySelectorAll<HTMLButtonElement>('.inspector-tab').forEach((tab) => tab.addEventListener('click', () => this.switchPanel(tab)));
    document.querySelector<HTMLSelectElement>('#canvas-ratio')?.addEventListener('change', (event) => {
      if (!this.activeProject) return;
      this.scheduleProjectSave({ ...this.activeProject, canvasRatio: (event.currentTarget as HTMLSelectElement).value as Project['canvasRatio'], updatedAt: Date.now() });
      this.updateCanvasDimensions();
      const selected = this.libraryRecords.find((record) => record.id === this.activeProject?.selectedMediaId);
      if (selected) void this.photoEditor.setContext(this.activeProject, selected);
    });
    document.querySelector<HTMLInputElement>('#export-quality')?.addEventListener('input', () => this.updateExportEstimate());
    document.querySelector<HTMLSelectElement>('#export-type')?.addEventListener('change', () => this.updateExportControls());
    document.querySelector<HTMLSelectElement>('#export-size')?.addEventListener('change', () => this.updateExportEstimate());
    document.querySelector<HTMLSelectElement>('#export-framerate')?.addEventListener('change', () => this.updateExportEstimate());
    document.querySelector('#start-export-button')?.addEventListener('click', () => void this.exportCurrent());
    document.querySelector('#cancel-export-button')?.addEventListener('click', () => this.exportAbort?.abort());
    document.querySelector('#clear-local-data-button')?.addEventListener('click', () => void this.clearLocalData());
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') this.flushProjectSave(); });
    window.addEventListener('pagehide', () => this.flushProjectSave());
    window.addEventListener('beforeunload', () => { this.flushProjectSave(); this.photoEditor.dispose(); });
  }

  private switchPanel(tab: HTMLButtonElement): void {
    document.querySelectorAll<HTMLButtonElement>('.inspector-tab').forEach((item) => {
      const active = item === tab;
      item.classList.toggle('active', active); item.setAttribute('aria-selected', String(active));
    });
    document.querySelectorAll<HTMLElement>('[role="tabpanel"]').forEach((panel) => { panel.hidden = panel.id !== tab.dataset.panel; });
    this.photoEditor.setActive(tab.dataset.panel === 'photo-panel');
    document.querySelector<HTMLElement>('.inspector')?.setAttribute('data-active-panel', tab.dataset.panel ?? '');
    if (tab.dataset.panel === 'export-panel') this.updateExportControls();
  }

  private async refreshActiveProject(): Promise<void> {
    if (!this.activeProject) return;
    const currentProject = this.activeProject;
    const storedProject = (await listProjects()).find((project) => project.id === currentProject.id);
    if (storedProject) this.activeProject = storedProject;
    this.libraryRecords = await listProjectMedia(this.activeProject.id);
    document.querySelector('#active-project-name')!.textContent = this.activeProject.name;
    document.querySelector('#canvas-project-name')!.textContent = this.activeProject.name;
    document.querySelector('#save-state')!.textContent = 'Saved locally';
    document.querySelector('#footer-save-state')!.textContent = 'All changes saved locally';
    this.library.update(this.activeProject, this.libraryRecords);
    this.sequenceView.update(this.activeProject, this.libraryRecords);
    this.renderProjects();
    const selected = this.libraryRecords.find((record) => record.id === this.activeProject?.selectedMediaId) ?? null;
    if (selected) await this.renderPreview(selected);
    else this.clearPreview();
    this.updateCanvasDimensions(); this.updateExportControls();
  }

  private renderProjects(): void {
    const nav = document.querySelector<HTMLElement>('#project-list')!;
    nav.replaceChildren();
    this.projects.sort((a, b) => b.updatedAt - a.updatedAt).forEach((project) => {
      const button = document.createElement('button');
      button.className = `project-link${project.id === this.activeProject?.id ? ' current-project' : ''}`;
      button.type = 'button'; button.title = project.name;
      const swatch = document.createElement('span'); swatch.className = 'project-swatch';
      const label = document.createElement('span'); label.className = 'project-label'; label.textContent = project.name;
      button.append(swatch, label);
      button.addEventListener('click', () => void this.openProject(project.id));
      nav.append(button);
    });
  }

  private async createNewProject(): Promise<void> {
    const name = await this.dialog.askName('Create a project', 'Start a new private project in this browser.', 'Untitled project');
    if (name === null) return;
    if (!name) { this.toast.show('Enter a project name to continue.'); return; }
    try {
      const project = createProject(name);
      await saveProject(project);
      this.projects = await listProjects(); this.activeProject = project;
      await this.refreshActiveProject();
      this.toast.show(`Created “${project.name}”`);
    } catch (error) { this.handleStorageError(error); }
  }

  private async renameProject(): Promise<void> {
    if (!this.activeProject) return;
    const name = await this.dialog.askName('Rename project', 'Choose a name for this project.', this.activeProject.name);
    if (name === null) return;
    if (!name) { this.toast.show('Project name cannot be empty.'); return; }
    this.activeProject = { ...this.activeProject, name, updatedAt: Date.now() };
    if (await this.persistActiveProject()) this.toast.show('Project renamed');
  }

  private async openProject(id: string): Promise<void> {
    const project = this.projects.find((item) => item.id === id);
    if (!project || project.id === this.activeProject?.id) return;
    this.activeProject = project;
    await this.refreshActiveProject();
  }

  private toggleProjectMenu(): void {
    const menu = document.querySelector<HTMLElement>('#project-menu')!;
    menu.hidden = !menu.hidden;
  }

  private async handleProjectMenu(event: Event): Promise<void> {
    const target = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-action]');
    if (!target || !this.activeProject) return;
    document.querySelector<HTMLElement>('#project-menu')!.hidden = true;
    switch (target.dataset.action) {
      case 'rename': await this.renameProject(); break;
      case 'duplicate': await this.duplicateProject(); break;
      case 'export': await this.exportProject(); break;
      case 'delete': await this.deleteProject(); break;
    }
  }

  private async duplicateProject(): Promise<void> {
    if (!this.activeProject) return;
    const name = await this.dialog.askName('Duplicate project', 'A copy of this project, including its media, will be stored in this browser.', `${this.activeProject.name} copy`);
    if (name === null) return;
    if (!name) { this.toast.show('Project name cannot be empty.'); return; }
    try {
      const target = createProject(name);
      this.activeProject = await cloneProjectRecords(this.activeProject, target);
      this.projects = await listProjects();
      await this.refreshActiveProject();
      this.toast.show('Project duplicated');
    } catch (error) { this.handleStorageError(error); }
  }

  private async deleteProject(): Promise<void> {
    if (!this.activeProject) return;
    if (!window.confirm(`Delete “${this.activeProject.name}” and its locally stored media? This cannot be undone.`)) return;
    try {
      await deleteProjectRecords(this.activeProject.id);
      this.projects = await listProjects();
      this.activeProject = this.projects[0] ?? createProject('Untitled project');
      if (!this.projects.length) { await saveProject(this.activeProject); this.projects = [this.activeProject]; }
      await this.refreshActiveProject(); await this.refreshStorageInfo();
      this.toast.show('Project deleted from this browser');
    } catch (error) { this.handleStorageError(error); }
  }

  private async exportProject(): Promise<void> {
    if (!this.activeProject) return;
    try { await exportProjectBundle(this.activeProject); this.toast.show('Project package downloaded'); }
    catch (error) { this.toast.show(errorMessage(error, 'Could not export this project package.'), 6000); this.boundary.capture(error, 'Project package export failed.'); }
  }

  private async importPackage(file: File): Promise<void> {
    try {
      this.setBusy(true);
      this.activeProject = await importProjectBundle(file);
      this.projects = await listProjects();
      await this.refreshActiveProject(); await this.refreshStorageInfo();
      this.toast.show(`Imported “${this.activeProject.name}”`);
    } catch (error) {
      this.handleStorageError(error);
      if (!errorMessage(error, '').toLocaleLowerCase().includes('quota')) {
        document.querySelector('#save-state')!.textContent = 'Saved locally';
        document.querySelector('#footer-save-state')!.textContent = 'All changes saved locally';
      }
    }
    finally { this.setBusy(false); }
  }

  private async importFiles(files: FileList | File[]): Promise<void> {
    if (!this.activeProject || !files.length) return;
    this.setBusy(true);
    const activeId = this.activeProject.id;
    try {
      const { records, rejected } = await prepareMediaFiles(activeId, files);
      if (this.activeProject.id !== activeId) return;
      if (records.length) {
        this.activeProject = await addMediaRecords(this.activeProject, records);
        const photoEdits = { ...this.activeProject.photoEdits };
        records.forEach((record) => { photoEdits[record.id] = createPhotoEdit(); });
        const sequence = [...this.activeProject.sequence, ...records.map((record) => ({ id: crypto.randomUUID(), mediaId: record.id, duration: record.kind === 'image' ? 3 : Math.max(0.5, Math.min(120, record.duration ?? 5)) }))];
        const first = records[0];
        this.activeProject = { ...this.activeProject, photoEdits, sequence, selectedMediaId: first.id, updatedAt: Date.now() };
        await saveProject(this.activeProject);
        await this.refreshActiveProject(); await this.refreshStorageInfo();
      }
      const acceptedMessage = records.length ? `Added ${records.length} ${records.length === 1 ? 'file' : 'files'}.` : '';
      const rejectedMessage = rejected.length ? ` ${rejected.map((item) => `${item.name}: ${item.reason}`).join(' · ')}` : '';
      if (records.length && !rejected.length) this.toast.show(acceptedMessage);
      else if (rejected.length) this.toast.show(`${acceptedMessage}${rejectedMessage}`, 7000);
      else this.toast.show('No supported media files were found.');
    } catch (error) { this.handleStorageError(error); }
    finally { this.setBusy(false); }
  }

  private async selectMedia(record: MediaRecord): Promise<void> {
    if (!this.activeProject) return;
    this.activeProject = { ...this.activeProject, selectedMediaId: record.id, updatedAt: Date.now() };
    await this.persistActiveProject();
    await this.renderPreview(record);
    this.library.update(this.activeProject, this.libraryRecords);
  }

  private async removeMedia(record: MediaRecord): Promise<void> {
    if (!this.activeProject) return;
    if (!window.confirm(`Remove “${record.name}” from this project and delete its local copy?`)) return;
    try {
      this.activeProject = await removeMediaRecord(this.activeProject, record.id);
      this.libraryRecords = await listProjectMedia(this.activeProject.id);
      if (!this.activeProject.selectedMediaId && this.libraryRecords[0]) {
        this.activeProject = { ...this.activeProject, selectedMediaId: this.libraryRecords[0].id };
        await saveProject(this.activeProject);
      }
      this.library.update(this.activeProject, this.libraryRecords);
      this.sequenceView.update(this.activeProject, this.libraryRecords);
      const selected = this.libraryRecords.find((item) => item.id === this.activeProject?.selectedMediaId);
      if (selected) await this.renderPreview(selected); else this.clearPreview();
      await this.refreshStorageInfo();
      this.toast.show('Media removed from this project');
    } catch (error) { this.handleStorageError(error); }
  }

  private async renderPreview(record: MediaRecord): Promise<void> {
    if (!this.activeProject) return;
    document.querySelector('#canvas-art')!.classList.add('has-upload');
    const isVideo = record.kind === 'video';
    document.querySelector('#canvas-status')!.textContent = isVideo ? 'VIDEO EDITOR · selected clip' : 'PHOTO EDITOR · selected image';
    document.querySelector('#workspace-hint')!.textContent = isVideo
      ? 'Video mode · adjust the selected clip, then open Sequence to arrange your story.'
      : 'Photo mode · adjust the image, add a caption, then drag layers on the canvas.';
    document.querySelector('#adjustment-heading')!.textContent = isVideo ? 'Clip adjustments' : 'Photo adjustments';
    document.querySelector('#adjustment-description')!.textContent = isVideo ? 'These non-destructive edits apply to this clip.' : 'Edits are non-destructive and saved with this photo.';
    await this.photoEditor.setContext(this.activeProject, record);
    const modePanel = document.querySelector<HTMLButtonElement>(`.inspector-tab[data-panel="${isVideo ? 'video-panel' : 'photo-panel'}"]`);
    if (modePanel) this.switchPanel(modePanel);
    document.querySelector('#sequence-selected-media')!.textContent = record.name;
  }

  private clearPreview(): void {
    document.querySelector('#canvas-art')!.classList.remove('has-upload');
    document.querySelector('#canvas-status')!.textContent = 'Local photo editor';
    document.querySelector('#workspace-hint')!.textContent = 'Select a photo or video to open its editing workspace.';
    document.querySelector('#sequence-selected-media')!.textContent = 'No clip selected';
    void this.photoEditor.setContext(this.activeProject!, null);
  }

  private togglePreviewPlayback(): void {
    this.toast.show('Video playback preview is part of the timeline phase. Export renders the full sequence.');
  }

  private addSelectedToSequence(): void {
    if (!this.activeProject) return;
    const record = this.libraryRecords.find((item) => item.id === this.activeProject?.selectedMediaId);
    if (!record) { this.toast.show('Choose a photo or video in Media first.'); return; }
    const duration = record.kind === 'image' ? 3 : Math.max(0.5, Math.min(120, record.duration ?? 5));
    this.scheduleProjectSave({ ...this.activeProject, sequence: [...this.activeProject.sequence, { id: crypto.randomUUID(), mediaId: record.id, duration }], updatedAt: Date.now() });
    this.toast.show(`Added “${record.name}” to the sequence`);
  }

  private scheduleProjectSave(project: Project): void {
    if (!this.activeProject || project.id !== this.activeProject.id) return;
    this.activeProject = project;
    this.sequenceView.update(project, this.libraryRecords);
    document.querySelector('#save-state')!.textContent = 'Saving locally…';
    document.querySelector('#footer-save-state')!.textContent = 'Saving changes locally';
    window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => void this.flushProjectSave(), 300);
    this.updateExportEstimate();
  }

  private async flushProjectSave(): Promise<void> {
    window.clearTimeout(this.saveTimer); this.saveTimer = 0;
    if (!this.activeProject) return;
    const project = this.activeProject;
    try {
      await saveProject(project);
      this.projects = await listProjects(); this.renderProjects();
      document.querySelector('#save-state')!.textContent = 'Saved locally';
      document.querySelector('#footer-save-state')!.textContent = 'All changes saved locally';
    } catch (error) { this.handleStorageError(error); }
  }

  private updateCanvasDimensions(): void {
    if (!this.activeProject) return;
    const size = outputDimensions(this.activeProject.canvasRatio, 1200);
    document.querySelector('#canvas-dimensions')!.textContent = `${size.width} × ${size.height}`;
    document.querySelector<HTMLSelectElement>('#canvas-ratio')!.value = this.activeProject.canvasRatio;
    document.querySelector<HTMLElement>('#canvas-art')!.style.aspectRatio = `${size.width} / ${size.height}`;
  }

  private updateExportControls(): void {
    const type = document.querySelector<HTMLSelectElement>('#export-type')!;
    const videoOption = type.querySelector<HTMLOptionElement>('option[value="video/sequence"]')!;
    const videoMime = supportedVideoMime();
    const videoAvailable = videoMime !== null;
    videoOption.disabled = !videoAvailable;
    videoOption.textContent = videoMime ? `Video sequence (${videoMime.includes('mp4') ? 'MP4' : 'WebM'})` : 'Video sequence (unsupported here)';
    if (!videoAvailable && type.value === 'video/sequence') type.value = 'image/png';
    const isVideo = type.value === 'video/sequence';
    document.querySelector<HTMLElement>('#framerate-field')!.hidden = !isVideo;
    document.querySelector<HTMLButtonElement>('#start-export-button')!.textContent = isVideo ? 'Export video sequence' : 'Export selected photo';
    this.updateExportEstimate();
  }

  private updateExportEstimate(): void {
    if (!this.activeProject) return;
    const isVideo = document.querySelector<HTMLSelectElement>('#export-type')?.value === 'video/sequence';
    const quality = Number(document.querySelector<HTMLInputElement>('#export-quality')?.value ?? 85) / 100;
    document.querySelector('#export-quality-value')!.textContent = `${Math.round(quality * 100)}%`;
    const estimate = document.querySelector<HTMLElement>('#export-estimate')!;
    if (isVideo) {
      const duration = this.activeProject.sequence.reduce((total, clip) => total + clip.duration, 0);
      const estimated = estimateVideoBytes(duration, quality);
      const status = duration > 120 ? 'Sequence exceeds the 120-second export limit.' : `${duration.toFixed(1)} sec · about ${formatBytes(estimated)} · WebM (silent)`;
      estimate.textContent = `${status} Video export runs in real time.`;
    } else {
      const longEdge = Number(document.querySelector<HTMLSelectElement>('#export-size')?.value ?? 1080);
      const dimensions = outputDimensions(this.activeProject.canvasRatio, longEdge);
      const record = this.libraryRecords.find((item) => item.id === this.activeProject?.selectedMediaId);
      estimate.textContent = record?.kind === 'image' ? `${dimensions.width} × ${dimensions.height} px · selected photo` : `Choose a photo in Media to export a still image · ${dimensions.width} × ${dimensions.height} px`;
    }
  }

  private async exportCurrent(): Promise<void> {
    if (!this.activeProject) return;
    const type = document.querySelector<HTMLSelectElement>('#export-type')!.value;
    const progress = document.querySelector<HTMLProgressElement>('#export-progress')!;
    const status = document.querySelector<HTMLElement>('#export-status')!;
    const start = document.querySelector<HTMLButtonElement>('#start-export-button')!;
    const cancel = document.querySelector<HTMLButtonElement>('#cancel-export-button')!;
    start.disabled = true; progress.hidden = false; progress.value = 0;
    try {
      await this.flushProjectSave();
      if (type === 'video/sequence') {
        const controller = new AbortController(); this.exportAbort = controller; cancel.hidden = false;
        status.textContent = 'Rendering video in real time… keep this tab open.';
        const size = outputDimensions(this.activeProject.canvasRatio, Number(document.querySelector<HTMLSelectElement>('#export-size')!.value));
        const result = await exportSequenceVideo(this.photoEditor.getRenderer(), this.activeProject, this.libraryRecords, {
          ...size, frameRate: Number(document.querySelector<HTMLSelectElement>('#export-framerate')!.value), quality: Number(document.querySelector<HTMLInputElement>('#export-quality')!.value) / 100,
        }, controller.signal, (value) => { progress.value = value; status.textContent = `Rendering video… ${Math.floor(value)}%`; });
        downloadBlob(result.blob, safeOutputName(this.activeProject.name, result.mimeType.includes('mp4') ? 'mp4' : 'webm'));
        status.textContent = `Video ready · ${formatBytes(result.blob.size)} · exported locally.`;
        this.toast.show('Video export downloaded');
      } else {
        const record = this.libraryRecords.find((item) => item.id === this.activeProject?.selectedMediaId);
        if (!record || record.kind !== 'image') throw new Error('Select a photo before exporting a still image.');
        status.textContent = 'Rendering photo…'; progress.value = 15;
        const size = outputDimensions(this.activeProject.canvasRatio, Number(document.querySelector<HTMLSelectElement>('#export-size')!.value));
        const blob = await exportStillImage(this.photoEditor.getRenderer(), record, this.activeProject, size.width, size.height, type as StillType, Number(document.querySelector<HTMLInputElement>('#export-quality')!.value) / 100);
        progress.value = 100;
        const extension = type === 'image/jpeg' ? 'jpg' : type === 'image/webp' ? 'webp' : 'png';
        downloadBlob(blob, safeOutputName(record.name.replace(/\.[^.]+$/, ''), extension));
        status.textContent = `Image ready · ${size.width} × ${size.height} · ${formatBytes(blob.size)}.`;
        this.toast.show('Photo export downloaded');
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') status.textContent = 'Export cancelled. Your project is unchanged.';
      else { status.textContent = errorMessage(error, 'Export failed.'); this.boundary.capture(error, 'Export failed. Your project is unchanged.'); }
    } finally {
      this.exportAbort = null; cancel.hidden = true; start.disabled = false; progress.hidden = true;
      this.photoEditor.getRenderer().clearCacheExcept(this.activeProject?.selectedMediaId ?? '');
    }
  }

  private async clearLocalData(): Promise<void> {
    const confirmed = window.confirm('Permanently delete every BYR project and its stored media from this browser? Export any project packages you want to keep first.');
    if (!confirmed) return;
    try {
      this.photoEditor.dispose();
      await clearWorkspaceRecords();
      this.activeProject = createProject('Untitled project');
      await saveProject(this.activeProject);
      this.projects = [this.activeProject];
      await this.refreshActiveProject(); await this.refreshStorageInfo();
      this.toast.show('Local BYR data cleared');
    } catch (error) { this.handleStorageError(error); }
  }

  private async persistActiveProject(): Promise<boolean> {
    if (!this.activeProject) return false;
    try {
      await saveProject(this.activeProject);
      this.projects = await listProjects();
      this.renderProjects();
      document.querySelector('#active-project-name')!.textContent = this.activeProject.name;
      document.querySelector('#canvas-project-name')!.textContent = this.activeProject.name;
      document.querySelector('#save-state')!.textContent = 'Saved locally';
      document.querySelector('#footer-save-state')!.textContent = 'All changes saved locally';
      return true;
    } catch (error) { this.handleStorageError(error); }
    return false;
  }

  private async refreshStorageInfo(): Promise<void> {
    try {
      const info = await getStorageInfo();
      const summary = info.usage === null ? 'Browser storage' : `${formatBytes(info.usage)} used`;
      document.querySelector('#storage-summary')!.textContent = summary;
    } catch {
      document.querySelector('#storage-summary')!.textContent = 'Browser storage';
    }
  }

  private async showStorageInfo(): Promise<void> {
    const info = await getStorageInfo();
    const persistence = info.persistent === true ? 'The browser has granted persistent storage for this site.' : 'The browser may clear stored data when space is low or when site data is cleared.';
    const quota = info.quota === null ? 'Storage estimates are not available in this browser.' : `This site currently uses about ${formatBytes(info.usage)} of an estimated ${formatBytes(info.quota)} available.`;
    await this.dialog.inform('Local storage', `${persistence} ${quota} Export project packages regularly for a portable backup.`);
  }

  private async showPrivacyInfo(): Promise<void> {
    const video = document.createElement('video');
    const codecSupport = ['video/mp4; codecs="avc1.42E01E"', 'video/webm; codecs="vp9"', 'video/webm; codecs="vp8"'].map((type) => `${type.split(';')[0]}: ${video.canPlayType(type) ? 'available' : 'not detected'}`).join(' · ');
    await this.dialog.inform('Private by design', `BYR reads files only after you choose them. Project data and media stay in this browser's IndexedDB and are not sent to a BYR server. Browser storage can be cleared, so use Project → Export project package for backups. Video playback capabilities: ${codecSupport}.`);
  }

  private handleStorageError(error: unknown): void {
    const message = errorMessage(error, 'The browser could not complete that action.');
    document.querySelector('#save-state')!.textContent = 'Could not save';
    document.querySelector('#footer-save-state')!.textContent = 'Save failed — export a backup if possible';
    this.toast.show(message.includes('Quota') || message.includes('quota') ? 'Not enough browser storage. Remove local media or free device space and try again.' : message, 7000);
    this.boundary.capture(error, 'Local project storage failed.');
  }

  private reportEditorError(message: string): void {
    this.toast.show(message, 6000);
    this.boundary.capture(new Error(message), 'The editor could not complete that action.');
  }

  private setBusy(busy: boolean): void {
    document.body.classList.toggle('is-busy', busy);
    const saveState = document.querySelector<HTMLElement>('#save-state')!;
    if (busy) saveState.textContent = 'Working locally…';
    else if (saveState.textContent === 'Working locally…') saveState.textContent = 'Saved locally';
  }
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
