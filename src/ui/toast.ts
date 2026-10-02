export class Toast {
  private timer = 0;

  constructor(private readonly element: HTMLElement) {}

  show(message: string, duration = 3000): void {
    this.element.textContent = message;
    this.element.classList.add('visible');
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.element.classList.remove('visible'), duration);
  }
}
