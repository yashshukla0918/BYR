export class AppErrorBoundary {
  private readonly banner: HTMLElement;
  private readonly message: HTMLElement;

  constructor() {
    this.banner = document.querySelector<HTMLElement>('#app-error-banner')!;
    this.message = document.querySelector<HTMLElement>('#app-error-message')!;
    document.querySelector('#dismiss-error-button')?.addEventListener('click', () => { this.banner.hidden = true; });
  }

  install(): void {
    window.addEventListener('error', (event) => {
      this.capture(event.error, 'The app hit an unexpected error. Your saved project data is unchanged.');
    });
    window.addEventListener('unhandledrejection', (event) => {
      event.preventDefault();
      this.capture(event.reason, 'A background action failed. Your saved project data is unchanged.');
    });
  }

  capture(error: unknown, fallback = 'This action could not be completed.'): void {
    const detail = error instanceof Error ? error.message : '';
    this.message.textContent = detail ? `${fallback} ${detail}` : fallback;
    this.banner.hidden = false;
  }

  async run<T>(operation: string, work: () => Promise<T>): Promise<T | undefined> {
    try { return await work(); }
    catch (error) { this.capture(error, `${operation} failed.`); return undefined; }
  }
}
